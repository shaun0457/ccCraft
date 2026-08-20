/*
 * Runs in YouTube page MAIN world.
 *
 * Important idea:
 * The raw caption baseUrl in ytInitialPlayerResponse can return HTTP 200 with an
 * empty body because it lacks the player proof-of-origin token. YouTube's own
 * player fetches the valid /api/timedtext URL after a caption track is enabled.
 *
 * This script hooks fetch and XHR, briefly enables the selected caption track,
 * captures the real timedtext URL, then turns native captions off again.
 */

(() => {
  const REQ = "cccraft-req";
  const RES = "cccraft-res";

  let lastTimedTextOriginal = null;
  const waiters = [];

  function toTimedTextUrl(value) {
    try {
      const url = new URL(String(value), location.origin);
      if (!url.pathname.includes("/api/timedtext")) return null;
      return url;
    } catch (_) {
      return null;
    }
  }

  function withFormat(value, fmt) {
    const url = toTimedTextUrl(value);
    if (!url) return null;
    if (fmt) url.searchParams.set("fmt", fmt);
    return url.toString();
  }

  // URL های گرفته‌شده را برای هر ویدیو نگه دار تا وقتی player از کش استفاده می‌کند و درخواست جدیدی نمی‌زند، استخراج fail نشود
  const capturedByVideo = new Map();

  function capture(value) {
    const url = toTimedTextUrl(value);
    if (!url) return;

    lastTimedTextOriginal = url.toString();

    const vid = url.searchParams.get("v");
    if (vid) capturedByVideo.set(vid, lastTimedTextOriginal);

    while (waiters.length) {
      try {
        waiters.shift()(lastTimedTextOriginal);
      } catch (_) {}
    }
  }

  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      const value = typeof input === "string" ? input : input && input.url;
      if (value && String(value).includes("/api/timedtext")) capture(value);
    } catch (_) {}
    return originalFetch.apply(this, arguments);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    try {
      if (url && String(url).includes("/api/timedtext")) capture(url);
    } catch (_) {}
    return originalOpen.apply(this, arguments);
  };

  function waitForCapturedUrl(timeoutMs) {
    return new Promise((resolve) => {
      if (lastTimedTextOriginal) return resolve(lastTimedTextOriginal);

      const waiter = (url) => resolve(url);
      waiters.push(waiter);

      setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        resolve(lastTimedTextOriginal);
      }, timeoutMs);
    });
  }

  function getPlayer() {
    return document.getElementById("movie_player");
  }

  function getPlayerResponse() {
    const player = getPlayer();
    let response = null;

    try {
      if (player && typeof player.getPlayerResponse === "function") {
        response = player.getPlayerResponse();
      }
    } catch (_) {}

    return response || window.ytInitialPlayerResponse || null;
  }

  async function ensureCaptionsModule(player) {
    try {
      if (player && typeof player.loadModule === "function") {
        player.loadModule("captions");
      }
    } catch (_) {}

    await new Promise((resolve) => setTimeout(resolve, 450));
  }

  function labelFromTrack(track) {
    if (!track) return "";

    const name = track.name;

    if (typeof track.displayName === "string") return track.displayName;
    if (typeof track.languageName === "string") return track.languageName;
    if (typeof track.label === "string") return track.label;
    if (typeof name === "string") return name;
    if (name?.simpleText) return name.simpleText;
    if (Array.isArray(name?.runs)) return name.runs.map((r) => r.text).join("");

    return track.languageCode || track.lang || track.vssId || "Unknown";
  }

  function normalizeTrack(track, index, source) {
    return {
      index,
      source,
      label: labelFromTrack(track),
      languageCode: track?.languageCode || track?.lang || "",
      kind: track?.kind || "manual",
      vssId: track?.vssId || "",
      isDefault: Boolean(track?.isDefault)
    };
  }

  async function getTrackLists() {
    const player = getPlayer();
    const response = getPlayerResponse();
    const responseTracks =
      response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

    let playerTracks = [];

    if (player) {
      await ensureCaptionsModule(player);

      try {
        playerTracks = player.getOption("captions", "tracklist") || [];
      } catch (_) {
        playerTracks = [];
      }

      if (!playerTracks.length) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        try {
          playerTracks = player.getOption("captions", "tracklist") || [];
        } catch (_) {
          playerTracks = [];
        }
      }
    }

    return { player, response, responseTracks, playerTracks };
  }

  function buildVisibleTracks(playerTracks, responseTracks) {
    const source = playerTracks.length ? "player" : "response";
    const list = playerTracks.length ? playerTracks : responseTracks;
    return list.map((track, index) => normalizeTrack(track, index, source));
  }

  function preferredIndex(tracks) {
    if (!tracks.length) return 0;

    const manualEnglish = tracks.find((t) => t.kind !== "asr" && (t.languageCode || "").startsWith("en"));
    const anyEnglish = tracks.find((t) => (t.languageCode || "").startsWith("en"));
    const manualAny = tracks.find((t) => t.kind !== "asr");

    return (manualEnglish || anyEnglish || manualAny || tracks[0]).index || 0;
  }

  async function captureCaptionUrl(trackIndex) {
    const { player, response, responseTracks, playerTracks } = await getTrackLists();

    if (!player) {
      return { ok: false, error: "YouTube player not found. Refresh the page." };
    }

    const list = playerTracks.length ? playerTracks : responseTracks;

    if (!list.length) {
      return { ok: false, error: "This video has no extractable subtitles." };
    }

    const index = Number.isInteger(trackIndex) ? trackIndex : preferredIndex(buildVisibleTracks(playerTracks, responseTracks));
    const selectedTrack = list[index] || list[0];

    // وضعیت فعلی caption کاربر را نگه دار تا بعد از استخراج برگردانده شود
    let previousTrack = null;
    try {
      previousTrack = player.getOption("captions", "track") || null;
    } catch (_) {}

    lastTimedTextOriginal = null;

    try {
      player.setOption("captions", "track", {});
    } catch (_) {}

    await new Promise((resolve) => setTimeout(resolve, 120));

    let captured = null;

    try {
      player.setOption("captions", "track", selectedTrack);
      captured = await waitForCapturedUrl(6500);
    } catch (_) {}

    if (!captured) {
      // Sometimes setting the same active track does not refetch. Toggle once more.
      try {
        player.setOption("captions", "track", {});
      } catch (_) {}

      await new Promise((resolve) => setTimeout(resolve, 250));

      try {
        player.setOption("captions", "track", selectedTrack);
        captured = await waitForCapturedUrl(6500);
      } catch (_) {}
    }

    // CC کاربر را به حالت قبل برگردان (قبلا همیشه خاموش می‌شد و CC یوتیوب ناپدید می‌ماند)
    try {
      if (previousTrack && (previousTrack.languageCode || previousTrack.vssId)) {
        player.setOption("captions", "track", previousTrack);
      } else {
        player.setOption("captions", "track", {});
      }
    } catch (_) {}

    const videoId =
      response?.videoDetails?.videoId ||
      new URL(location.href).searchParams.get("v") ||
      null;

    // اگر درخواست جدیدی ثبت نشد (player از کش استفاده کرده)، از URL قبلا گرفته‌شده همین ویدیو استفاده کن
    if (!captured && videoId && capturedByVideo.has(videoId)) {
      captured = capturedByVideo.get(videoId);
    }

    // آخرین راه: baseUrl خود ترک از playerResponse
    if (!captured) {
      const fallbackTrack =
        responseTracks.find((t) => t.vssId && selectedTrack?.vssId && t.vssId === selectedTrack.vssId) ||
        responseTracks.find((t) => (t.languageCode || "") === (selectedTrack?.languageCode || selectedTrack?.lang || "")) ||
        null;

      if (fallbackTrack?.baseUrl) {
        const base = toTimedTextUrl(fallbackTrack.baseUrl);
        if (base) captured = base.toString();
      }
    }

    if (!captured) {
      return {
        ok: false,
        error: "Could not capture the real caption URL from the player. Turn captions on once in YouTube itself and try again."
      };
    }

    return {
      ok: true,
      videoId,
      originalUrl: captured,
      json3Url: withFormat(captured, "json3"),
      track: normalizeTrack(selectedTrack, index, playerTracks.length ? "player" : "response")
    };
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;

    const data = event.data;
    if (!data || data.channel !== REQ || !data.reqId) return;

    try {
      if (data.type === "GET_TRACKS") {
        const { response, responseTracks, playerTracks } = await getTrackLists();
        const tracks = buildVisibleTracks(playerTracks, responseTracks);

        window.postMessage({
          channel: RES,
          reqId: data.reqId,
          ok: true,
          videoId: response?.videoDetails?.videoId || null,
          tracks,
          preferredIndex: preferredIndex(tracks)
        }, "*");

        return;
      }

      if (data.type === "CAPTURE_CAPTION_URL") {
        const result = await captureCaptionUrl(data.trackIndex);
        window.postMessage({
          channel: RES,
          reqId: data.reqId,
          ...result
        }, "*");

        return;
      }
    } catch (err) {
      window.postMessage({
        channel: RES,
        reqId: data.reqId,
        ok: false,
        error: err && err.message ? err.message : String(err)
      }, "*");
    }
  });
})();
