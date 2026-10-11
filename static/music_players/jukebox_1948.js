// 1948 Jukebox Music Player
// A late-1940s jukebox take on the music player used in the mod 1932 (and other mods).
// It keeps the same API (Song, Playlist, changePlaylist, updateUI) and the same
// YouTube support, but everything you see is drawn with CSS: a 78 r.p.m. record
// spinning under a glass dome, a typed title strip, a program of selections,
// Bakelite keys, a volume knob and bubble-tube pilasters. No image assets needed.
//
// To use it, paste this whole file into your mod's Code 2 and edit JUKEBOX_SONGS below.
(function () {
  // [title, artist, cover image link ("" prints a 78 label instead), audio link or YouTube link]
  const JUKEBOX_SONGS = [
    ["Twelfth Street Rag", "Pee Wee Hunt", "", "https://audio.jukehost.co.uk/6Af2WZKp4sSedpGG3D6KtVDLctnDPaoG"],
    ["I'm Looking Over a Four Leaf Clover", "Art Mooney", "", "https://audio.jukehost.co.uk/gpY5mk2inQRxstI4L7PRpPPcg9zqy20W"],
    ["Mañana (Is Soon Enough for Me)", "Peggy Lee", "", "https://audio.jukehost.co.uk/JziQ6RDYmoPV05jZmdNtvUmeqHPd7X5l"],
    ["Good Rockin' Tonight", "Wynonie Harris", "", "https://audio.jukehost.co.uk/ExyrxtLKFPd2NK5SpD0sHlRrX4jJIXL4"],
    ["A Mansion on the Hill", "Hank Williams", "", "https://audio.jukehost.co.uk/jk1UDY1V04sqScofi74KpiAUde2u5Rwq"]
  ];

  // volume runs from 0 to 20, like the 1932 player
  const DEFAULT_VOLUME = 6;
  const VOLUME_KEY = "jukebox1948_volume";

  // label colours for records without cover art
  const LABEL_COLORS = ["#7a1424", "#1d2b5c", "#1a1414", "#1f4a2c", "#4b1f4f", "#8a3b12"];

  // a real 78 turns once every 60/78 seconds
  const SECONDS_PER_TURN = 60 / 78;

  // tone arm angles: resting off the record, at the outer groove, and the sweep in to the run-out
  const ARM_REST = -15;
  const ARM_START = -6.1;
  const ARM_SWEEP = 20.4;

  // if another music player is already on the page, leave it alone
  const existingPlayer = document.getElementById("player");
  if (existingPlayer) {
    if (existingPlayer.classList.contains("jk48") && window.jukebox1948) {
      window.jukebox1948.exportApi();
    } else {
      console.warn("A music player is already on the page. The 1948 jukebox will not be added.");
    }
    return;
  }

  class Song {
    constructor(title, artist, coverLink, audioOrYouTube) {
      this.title = title;
      this.artist = artist;
      this.coverLink = coverLink;
      // detect and parse YouTube IDs, otherwise treat as a standard audio link
      this.youtubeId = extractYouTubeId(audioOrYouTube);
      this.audioLink = this.youtubeId ? null : (audioOrYouTube || null);
    }
    getTitle() { return this.title; }
    getArtist() { return this.artist; }
    getCoverLink() { return this.coverLink; }
    getAudioLink() { return this.audioLink; }
    getYouTubeId() { return this.youtubeId; }
  }

  class Playlist {
    constructor() {
      this.songs = [];
      this.currentSongIndex = 0;
    }
    addSong(song) { this.songs.push(song); }
    getCurrentSong() { return this.songs[this.currentSongIndex]; }

    playNext() {
      if (this.songs.length === 0) return;
      this.currentSongIndex = (this.currentSongIndex + 1) % this.songs.length;
    }

    playPrevious() {
      if (this.songs.length === 0) return;
      this.currentSongIndex = (this.currentSongIndex - 1 + this.songs.length) % this.songs.length;
    }
  }

  let activePlaylist = new Playlist();
  let audioInstance = null;
  let currentVolume = loadVolume();
  let backendVolume = currentVolume / 20;

  // playback state
  let isPlaying = false;   // the record is actually turning
  let wantPlaying = false; // the listener asked for music
  let buffering = false;
  let hasError = false;
  let seeking = false;
  let shownSong = null;
  let renderedPlaylist = null;
  let renderedCount = -1;
  let swapTimer = null;
  const brokenCovers = new Set();

  // YouTube URL support
  const yt = {
    player: null,
    ready: false,
    creating: false,
    failed: false,
    loadedId: null
  };

  function extractYouTubeId(url) {
    if (typeof url !== "string") return null;
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|v\/|shorts\/|live\/))([\w-]{11})/);
    return match ? match[1] : null;
  }

  function isYouTubeSong(song) {
    return !!song?.getYouTubeId?.();
  }

  function currentSong() {
    return activePlaylist?.getCurrentSong?.();
  }

  function ytActive() {
    return isYouTubeSong(currentSong());
  }

  function loadVolume() {
    try {
      const saved = parseInt(localStorage.getItem(VOLUME_KEY), 10);
      if (Number.isFinite(saved) && saved >= 0 && saved <= 20) return saved;
    } catch (e) {}
    return DEFAULT_VOLUME;
  }

  function saveVolume() {
    try { localStorage.setItem(VOLUME_KEY, String(currentVolume)); } catch (e) {}
  }

  // the YouTube API is only fetched once a YouTube song is actually picked
  function injectYouTubeAPI() {
    if (window.YT && typeof window.YT.Player === "function") return;
    if (document.getElementById("yt-iframe-api") || document.querySelector('script[src*="youtube.com/iframe_api"]')) return;
    const tag = document.createElement("script");
    tag.id = "yt-iframe-api";
    tag.src = "https://www.youtube.com/iframe_api";
    // if it fails, take the tag away so a later try can fetch it again
    tag.onerror = () => tag.remove();
    document.head.appendChild(tag);
  }

  function applyVolumeToYT() {
    if (!yt.player || !yt.ready) return;
    try {
      yt.player.setVolume(Math.round(backendVolume * 100));
      if (backendVolume === 0) yt.player.mute();
      else yt.player.unMute();
    } catch (e) {}
  }

  function ensureYTPlayer() {
    if (yt.player || yt.creating || yt.failed) return;
    yt.creating = true;
    injectYouTubeAPI();

    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (window.YT && typeof window.YT.Player === "function") {
        clearInterval(timer);
        createYTPlayer();
      } else if (Date.now() - startedAt > 15000) {
        clearInterval(timer);
        yt.creating = false;
        yt.failed = true;
        console.log("The YouTube player could not be loaded.");
        if (ytActive()) {
          hasError = true;
          wantPlaying = false;
          render();
        }
      }
    }, 100);
  }

  function createYTPlayer() {
    let holder = document.getElementById("ytplayer");
    if (!holder) {
      holder = document.createElement("div");
      holder.id = "ytplayer";
      holder.style.width = "0px";
      holder.style.height = "0px";
      holder.style.position = "absolute";
      holder.style.overflow = "hidden";
      holder.style.pointerEvents = "none";
      document.body.appendChild(holder);
    }

    try {
      yt.player = new YT.Player(holder, {
        height: "0",
        width: "0",
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          fs: 0,
          rel: 0,
          playsinline: 1
        },
        events: {
          onReady: (e) => {
            yt.player = e.target;
            yt.ready = true;
            yt.creating = false;
            syncYouTube();
          },
          onStateChange: onYouTubeStateChange,
          onError: () => {
            if (!ytActive()) return;
            hasError = true;
            wantPlaying = false;
            isPlaying = false;
            buffering = false;
            render();
          }
        }
      });
    } catch (e) {
      yt.creating = false;
      yt.failed = true;
      console.log("Could not create the YouTube player.", e);
      if (ytActive()) {
        hasError = true;
        wantPlaying = false;
        render();
      }
    }
  }

  function onYouTubeStateChange(e) {
    if (!ytActive()) return;
    const S = window.YT.PlayerState;
    if (e.data === S.PLAYING) {
      buffering = false;
      isPlaying = true;
      applyVolumeToYT();
    } else if (e.data === S.BUFFERING) {
      buffering = true;
      isPlaying = true;
    } else if (e.data === S.ENDED) {
      buffering = false;
      isPlaying = false;
      advanceToNextSong();
      return;
    } else if (e.data === S.PAUSED) {
      buffering = false;
      isPlaying = false;
      wantPlaying = false;
    } else {
      // cued or unstarted
      buffering = false;
      isPlaying = false;
    }
    render();
  }

  // bring the YouTube player in line with the current song and what the listener wants
  function syncYouTube() {
    const song = currentSong();
    if (!isYouTubeSong(song) || !yt.ready) return;
    const id = song.getYouTubeId();
    try {
      if (yt.loadedId !== id) {
        yt.loadedId = id;
        if (wantPlaying) yt.player.loadVideoById(id);
        else yt.player.cueVideoById(id);
      } else if (wantPlaying) {
        yt.player.playVideo();
      } else {
        yt.player.pauseVideo();
      }
    } catch (e) {
      console.log("YouTube playback failed.", e);
    }
    applyVolumeToYT();
  }

  function clearAudio(audio) {
    if (!audio.getAttribute("src")) return;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }

  function stopYouTube() {
    yt.loadedId = null;
    if (!yt.ready) return;
    try { yt.player.stopVideo(); } catch (e) {}
  }

  function backendSetSrcAndLoad(song, audio, autoplay) {
    hasError = false;
    buffering = false;
    isPlaying = false;
    wantPlaying = !!(song && autoplay);

    if (!song) {
      clearAudio(audio);
      stopYouTube();
      return;
    }

    if (isYouTubeSong(song)) {
      clearAudio(audio);
      yt.loadedId = null;
      // a slow connection may have timed out before; try loading YouTube again
      yt.failed = false;
      ensureYTPlayer();
      syncYouTube();
      return;
    }

    stopYouTube();
    const link = song.getAudioLink?.();
    if (!link) {
      clearAudio(audio);
      hasError = true;
      wantPlaying = false;
      return;
    }
    audio.src = link;
    audio.load();
    if (autoplay) backendPlay(audio);
  }

  function backendPlay(audio) {
    const song = currentSong();
    if (!song || hasError) return Promise.resolve();
    wantPlaying = true;

    if (isYouTubeSong(song)) {
      ensureYTPlayer();
      syncYouTube();
      render();
      return Promise.resolve();
    }

    return audio.play().catch(e => {
      // a newer song interrupted this one, nothing to undo
      if (e && e.name === "AbortError") return;
      console.log("Playback deferred for user interaction.", e);
      wantPlaying = false;
      render();
    });
  }

  function backendPause(audio) {
    const song = currentSong();
    wantPlaying = false;
    if (!song) return;

    if (isYouTubeSong(song)) {
      syncYouTube();
      render();
    } else {
      audio.pause();
    }
  }

  function backendSetVolume(audio, volume) {
    backendVolume = volume;
    audio.volume = volume;
    applyVolumeToYT();
  }

  function backendGetCurrentTime() {
    if (ytActive()) {
      if (!yt.ready) return 0;
      try { return yt.player.getCurrentTime() || 0; } catch (e) { return 0; }
    }
    const audio = getAudioElement();
    return audio.currentTime || 0;
  }

  function backendGetDuration() {
    if (ytActive()) {
      if (!yt.ready) return 0;
      try { return yt.player.getDuration() || 0; } catch (e) { return 0; }
    }
    const audio = getAudioElement();
    return audio.duration || 0;
  }

  function backendSeekTo(seconds) {
    if (ytActive()) {
      if (yt.ready) {
        try { yt.player.seekTo(seconds, true); } catch (e) {}
      }
    } else {
      const audio = getAudioElement();
      if (Number.isFinite(audio.duration)) audio.currentTime = seconds;
    }
  }

  // helpers
  function getAudioElement() {
    if (!audioInstance) {
      audioInstance = document.getElementById("audio");
      if (!audioInstance || audioInstance.tagName !== "AUDIO") {
        audioInstance = document.createElement("audio");
        audioInstance.id = "audio";
        document.body.appendChild(audioInstance);
      }
      audioInstance.preload = "auto";
    }
    return audioInstance;
  }

  function el(id) {
    return document.getElementById(id);
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m + ":" + String(s).padStart(2, "0");
  }

  function textOf(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    return String(value);
  }

  function updatePlayPauseIcon(playing) {
    const btn = el("playPauseButton");
    if (!btn) return;
    btn.classList.toggle("is-on", playing);
    btn.setAttribute("aria-label", playing ? "Pause" : "Play");
    btn.title = playing ? "Pause" : "Play";
    const caption = btn.querySelector(".jk48-caption");
    if (caption) caption.textContent = playing ? "PAUSE" : "PLAY";
  }

  function statusText() {
    if (!currentSong()) return "NO RECORDS";
    if (hasError) return "OUT OF ORDER";
    if (isPlaying && buffering) return "WARMING UP";
    if (isPlaying) return "NOW PLAYING";
    if (wantPlaying) return "WARMING UP";
    return "PAUSED";
  }

  // repaint everything that depends on the playback state
  function render() {
    const player = el("player");
    if (!player) return;
    const showPlaying = isPlaying || (wantPlaying && !hasError && ytActive() && !yt.ready);
    player.classList.toggle("is-playing", isPlaying);
    player.classList.toggle("is-error", hasError);
    updatePlayPauseIcon(showPlaying);
    // only write real changes, so screen readers hear each state once
    const status = el("jk48-status");
    const text = statusText();
    if (status && status.textContent !== text) status.textContent = text;
  }

  function paintProgress(current, duration) {
    const player = el("player");
    if (!player || seeking) return;
    const ratio = Number.isFinite(duration) && duration > 0 ? Math.min(Math.max(current / duration, 0), 1) : 0;
    paintDial(ratio, current, duration);
  }

  function paintDial(ratio, current, duration) {
    const player = el("player");
    const dial = el("progress-bar");
    if (!player || !dial) return;
    player.style.setProperty("--jk48-progress", (ratio * 100).toFixed(2) + "%");
    // the tone arm walks in from the outer groove as the record plays
    player.style.setProperty("--jk48-arm-play", (ARM_START + ratio * ARM_SWEEP).toFixed(2) + "deg");
    const elapsed = el("jk48-elapsed");
    const total = el("jk48-duration");
    const hasDuration = Number.isFinite(duration) && duration > 0;
    if (elapsed) elapsed.textContent = formatTime(current);
    if (total) total.textContent = hasDuration ? formatTime(duration) : "-:--";
    dial.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    dial.setAttribute("aria-valuetext", hasDuration ? formatTime(current) + " of " + formatTime(duration) : "Not loaded");
  }

  function paintVolume() {
    const player = el("player");
    const knob = el("jk48-knob");
    if (!player || !knob) return;
    player.style.setProperty("--jk48-knob", (-135 + (currentVolume / 20) * 270) + "deg");
    knob.setAttribute("aria-valuenow", String(currentVolume));
    knob.setAttribute("aria-valuetext", Math.round((currentVolume / 20) * 100) + "%");
    knob.title = "Volume " + Math.round((currentVolume / 20) * 100) + "%";
  }

  function setVolumeLevel(level) {
    const next = Math.min(Math.max(Math.round(level), 0), 20);
    if (next === currentVolume) return false;
    currentVolume = next;
    backendSetVolume(getAudioElement(), currentVolume / 20);
    saveVolume();
    paintVolume();
    return true;
  }

  function pressButton(button) {
    if (!button) return;
    button.classList.add("is-pressed");
    setTimeout(() => button.classList.remove("is-pressed"), 160);
  }

  // print the record label, or set the cover art into it
  function paintLabel(song, index) {
    const label = el("jk48-label");
    const cover = el("cover");
    if (!label || !cover) return;
    label.style.setProperty("--jk48-label-bg", LABEL_COLORS[index % LABEL_COLORS.length]);
    el("jk48-label-title").textContent = textOf(song?.getTitle?.(), "");
    el("jk48-label-artist").textContent = textOf(song?.getArtist?.(), "");
    const link = song?.getCoverLink?.();
    if (link && !brokenCovers.has(link)) {
      cover.hidden = false;
      label.classList.add("has-cover");
      if (cover.getAttribute("src") !== link) cover.src = link;
    } else {
      cover.hidden = true;
      label.classList.remove("has-cover");
      cover.removeAttribute("src");
    }
  }

  function renderProgram(playlist) {
    const list = el("jk48-program");
    if (!list) return;
    list.textContent = "";
    playlist.songs.forEach((song, i) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "jk48-pick";
      button.dataset.index = String(i);

      const number = document.createElement("span");
      number.className = "jk48-pick-no";
      number.textContent = String(i + 1);

      const words = document.createElement("span");
      words.className = "jk48-pick-words";
      const title = document.createElement("span");
      title.className = "jk48-pick-title";
      title.textContent = textOf(song?.getTitle?.(), "Untitled");
      const artist = document.createElement("span");
      artist.className = "jk48-pick-artist";
      artist.textContent = textOf(song?.getArtist?.(), "");
      words.append(title, artist);

      button.append(number, words);
      button.setAttribute("aria-label", "Selection " + (i + 1) + ": " + title.textContent + (artist.textContent ? " by " + artist.textContent : ""));
      item.appendChild(button);
      list.appendChild(item);
    });
    renderedPlaylist = playlist;
    renderedCount = playlist.songs.length;
  }

  function highlightProgram(playlist) {
    const list = el("jk48-program");
    if (!list) return;
    let active = null;
    list.querySelectorAll(".jk48-pick").forEach(button => {
      const on = Number(button.dataset.index) === playlist.currentSongIndex;
      button.classList.toggle("is-current", on);
      if (on) {
        button.setAttribute("aria-current", "true");
        active = button;
      } else {
        button.removeAttribute("aria-current");
      }
    });
    // keep the current selection in view without scrolling the page
    if (active) {
      const item = active.parentElement;
      const top = item.offsetTop - list.offsetTop;
      if (top < list.scrollTop) list.scrollTop = top - 4;
      else if (top + item.offsetHeight > list.scrollTop + list.clientHeight) {
        list.scrollTop = top + item.offsetHeight - list.clientHeight + 4;
      }
    }
  }

  function updateUI(playlist) {
    const player = el("player");
    if (!player || !playlist?.songs) return;
    const song = playlist.getCurrentSong();
    const index = playlist.currentSongIndex || 0;

    // the program always lists the playlist its buttons play from
    if (activePlaylist !== renderedPlaylist || activePlaylist.songs.length !== renderedCount) renderProgram(activePlaylist);
    highlightProgram(activePlaylist);

    const title = player.querySelector("#title");
    const artist = player.querySelector("#artist");
    const selection = el("jk48-selection");
    const nextUp = el("jk48-next");
    const count = playlist.songs.length;

    if (!song) {
      if (title) title.textContent = "No Records Loaded";
      if (artist) artist.textContent = "Out of Order";
      if (selection) selection.textContent = "SELECTION —";
      if (nextUp) nextUp.textContent = "";
      cancelSwap(player);
      paintLabel(null, 0);
      shownSong = null;
      render();
      return;
    }

    if (title) title.textContent = textOf(song.getTitle?.(), "Untitled");
    if (artist) artist.textContent = textOf(song.getArtist?.(), "Unknown Artist");
    if (selection) selection.textContent = "SELECTION No. " + (index + 1);
    if (nextUp) {
      const next = count > 1 ? playlist.songs[(index + 1) % count] : null;
      nextUp.textContent = next ? "NEXT: " + textOf(next.getTitle?.(), "Untitled") : "";
    }

    // the changer lifts the old record off and drops the new one on
    if (shownSong && shownSong !== song) {
      player.classList.remove("is-swapping");
      void player.offsetWidth;
      player.classList.add("is-swapping");
      clearTimeout(swapTimer);
      const swapIn = song;
      swapTimer = setTimeout(() => {
        paintLabel(swapIn, index);
        swapTimer = setTimeout(() => player.classList.remove("is-swapping"), 320);
      }, 280);
    } else if (shownSong !== song) {
      cancelSwap(player);
      paintLabel(song, index);
    }
    shownSong = song;
    render();
  }

  // stop a record change part-way, so its timer can't repaint an old label later
  function cancelSwap(player) {
    clearTimeout(swapTimer);
    swapTimer = null;
    player.classList.remove("is-swapping");
  }

  function playSongAtIndex() {
    updateUI(activePlaylist);
    backendSetSrcAndLoad(activePlaylist.getCurrentSong(), getAudioElement(), true);
    paintProgress(0, 0);
    render();
  }

  function advanceToNextSong() {
    activePlaylist.playNext();
    playSongAtIndex();
  }

  function playPreviousSong() {
    activePlaylist.playPrevious();
    playSongAtIndex();
  }

  function selectSong(index) {
    const count = activePlaylist.songs.length;
    if (!count) return;
    if (index === activePlaylist.currentSongIndex && !hasError) {
      togglePlayPause();
      return;
    }
    activePlaylist.currentSongIndex = ((index % count) + count) % count;
    playSongAtIndex();
  }

  function togglePlayPause() {
    const audio = getAudioElement();
    const showingPlay = isPlaying || (wantPlaying && ytActive() && !yt.ready);
    if (hasError) {
      // try the record again
      backendSetSrcAndLoad(currentSong(), audio, true);
      render();
      return;
    }
    if (showingPlay) backendPause(audio);
    else backendPlay(audio);
    render();
  }

  function changePlaylist(newPlaylist) {
    if (!newPlaylist || !Array.isArray(newPlaylist.songs) || typeof newPlaylist.getCurrentSong !== "function") {
      console.warn("changePlaylist needs a Playlist.");
      return;
    }
    activePlaylist = newPlaylist;
    activePlaylist.currentSongIndex = 0;

    updateUI(activePlaylist);

    const audio = getAudioElement();
    const song = activePlaylist.getCurrentSong();
    backendSetSrcAndLoad(song, audio, !!song);
    paintProgress(0, 0);
    render();
  }

  function exportApi() {
    window.Song = Song;
    window.Playlist = Playlist;
    window.changePlaylist = changePlaylist;
    window.updateUI = updateUI;
    window.jukebox1948 = {
      exportApi,
      play: () => { backendPlay(getAudioElement()); render(); },
      pause: () => { backendPause(getAudioElement()); render(); },
      toggle: togglePlayPause,
      next: advanceToNextSong,
      previous: playPreviousSong,
      // index starts at 0
      select: (index) => {
        const count = activePlaylist.songs.length;
        const i = Math.trunc(Number(index));
        if (!count || !Number.isFinite(i)) return;
        activePlaylist.currentSongIndex = ((i % count) + count) % count;
        playSongAtIndex();
      },
      setVolume: setVolumeLevel,
      getPlaylist: () => activePlaylist
    };
  }

  function icon(name) {
    const paths = {
      prev: "M5 4h2.4v16H5zM20 4v16L8.6 12z",
      play: "M7 4.5v15l12.5-7.5z",
      pause: "M6 4.5h4.4v15H6zM13.6 4.5H18v15h-4.4z",
      next: "M16.6 4H19v16h-2.4zM4 4l11.4 8L4 20z"
    };
    return '<svg class="jk48-icon jk48-icon-' + name + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="' + paths[name] + '"/></svg>';
  }

  function bubbles() {
    let html = "";
    for (let i = 0; i < 6; i++) html += "<i></i>";
    return html;
  }

  function injectStyles() {
    if (el("jk48-styles")) return;

    if (!el("jk48-fonts")) {
      const fonts = document.createElement("link");
      fonts.id = "jk48-fonts";
      fonts.rel = "stylesheet";
      fonts.href = "https://fonts.googleapis.com/css2?family=Limelight&family=Special+Elite&display=swap";
      document.head.appendChild(fonts);
    }

    const style = document.createElement("style");
    style.id = "jk48-styles";
    style.textContent = `
    #player.jk48 {
      --jk48-chrome: linear-gradient(180deg, #fbfbfb 0%, #cfd2d6 18%, #8f949b 46%, #eceef0 56%, #a2a7ad 80%, #f3f4f5 100%);
      --jk48-chrome-side: linear-gradient(90deg, #9da2a9 0%, #f4f5f6 30%, #c3c7cc 55%, #7f848b 100%);
      --jk48-cream: #f5ecd6;
      --jk48-ink: #231d17;
      --jk48-red: #b11f2b;
      --jk48-deep-red: #6d0f18;
      --jk48-amber: #ffbf4d;
      --jk48-walnut: #4a2410;
      --jk48-deco: "Limelight", "Copperplate", "Copperplate Gothic Light", Georgia, serif;
      --jk48-type: "Special Elite", "Courier New", Courier, monospace;
      --jk48-progress: 0%;
      --jk48-arm-rest: ${ARM_REST}deg;
      --jk48-arm-play: ${ARM_START}deg;
      --jk48-knob: -54deg;
      --jk48-turn: ${SECONDS_PER_TURN.toFixed(4)}s;
      container-type: inline-size;
      position: relative;
      margin: 0.5em;
      font-size: 13px;
      line-height: 1.25;
      text-align: left;
      color: var(--jk48-ink);
      font-family: Georgia, "Times New Roman", serif;
      -webkit-user-select: none;
      user-select: none;
    }
    #player.jk48 *, #player.jk48 *::before, #player.jk48 *::after {
      box-sizing: border-box;
    }
    #player.jk48 ol, #player.jk48 li {
      margin: 0;
      padding: 0;
      list-style: none;
      line-height: inherit;
    }
    #player.jk48 button {
      margin: 0;
      padding: 0;
      border: 0;
      background: none;
      font: inherit;
      color: inherit;
      text-transform: none;
      letter-spacing: normal;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
    }
    #player.jk48 button:focus-visible,
    #player.jk48 [role="slider"]:focus-visible {
      outline: 2px solid #ffd27a;
      outline-offset: 2px;
    }
    #player.jk48 .jk48-controls :focus-visible {
      outline-color: #2a1206;
    }

    /* cabinet */
    #player.jk48 .jk48-cabinet {
      display: flex;
      align-items: stretch;
      gap: 10px;
      padding: 10px;
      border-radius: 22px 22px 12px 12px;
      border: 3px solid #2a1206;
      background:
        repeating-linear-gradient(91deg, rgba(0, 0, 0, 0.09) 0 2px, transparent 2px 7px),
        repeating-linear-gradient(87deg, rgba(255, 230, 200, 0.05) 0 1px, transparent 1px 13px),
        radial-gradient(ellipse at 30% 20%, rgba(255, 190, 120, 0.18), transparent 60%),
        linear-gradient(180deg, #6e3b1c 0%, #4a2410 55%, #351707 100%);
      box-shadow:
        inset 0 0 0 2px #b9bec4,
        inset 0 0 0 4px #5a2c12,
        inset 0 10px 24px rgba(0, 0, 0, 0.35),
        0 6px 16px rgba(0, 0, 0, 0.35);
    }
    #player.jk48 .jk48-body {
      flex: 1 1 auto;
      min-width: 0;
      display: grid;
      grid-template-columns: 232px minmax(0, 1fr) 220px;
      grid-template-areas: "dome center program";
      gap: 12px;
      align-items: stretch;
    }

    /* glowing plastic pilasters with bubble tubes */
    #player.jk48 .jk48-pilaster {
      position: relative;
      flex: 0 0 40px;
      border-radius: 20px 20px 6px 6px;
      overflow: hidden;
      background:
        repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.22) 0 2px, rgba(0, 0, 0, 0.12) 2px 5px, transparent 5px 8px),
        linear-gradient(180deg, #ff5a2a 0%, #ffb52b 30%, #ffe07a 50%, #ffb52b 70%, #e8371f 100%);
      box-shadow: inset 0 0 0 3px rgba(255, 255, 255, 0.25), inset 0 0 14px rgba(120, 20, 0, 0.6), 0 0 0 2px #2a1206, 0 0 0 4px #b9bec4;
      animation: jk48-glow 9s ease-in-out infinite alternate;
    }
    #player.jk48 .jk48-pilaster::before,
    #player.jk48 .jk48-pilaster::after {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      height: 14px;
      background: var(--jk48-chrome);
      z-index: 2;
    }
    #player.jk48 .jk48-pilaster::before { top: 0; border-radius: 20px 20px 0 0; }
    #player.jk48 .jk48-pilaster::after { bottom: 0; }
    #player.jk48 .jk48-tube {
      position: absolute;
      top: 18px;
      bottom: 18px;
      left: 50%;
      width: 12px;
      margin-left: -6px;
      border-radius: 6px;
      overflow: hidden;
      background:
        linear-gradient(90deg, rgba(255, 255, 255, 0.55), rgba(255, 255, 255, 0.05) 40%, rgba(0, 0, 0, 0.18)),
        linear-gradient(180deg, #ff9a3c, #ff3d2e);
      box-shadow: 0 0 0 1px rgba(90, 20, 0, 0.5), 0 0 8px rgba(255, 210, 120, 0.8);
    }
    #player.jk48 .jk48-right .jk48-tube {
      background:
        linear-gradient(90deg, rgba(255, 255, 255, 0.55), rgba(255, 255, 255, 0.05) 40%, rgba(0, 0, 0, 0.18)),
        linear-gradient(180deg, #8ee07a, #2f9e4a);
    }
    #player.jk48 .jk48-tube i {
      position: absolute;
      left: 50%;
      top: 100%;
      width: 5px;
      height: 5px;
      margin-left: -2.5px;
      border-radius: 50%;
      background: radial-gradient(circle at 35% 35%, #fff, rgba(255, 255, 255, 0.35) 60%, transparent 70%);
      animation: jk48-bubble 3.4s linear infinite;
    }
    #player.jk48 .jk48-tube i:nth-child(2) { animation-delay: -0.6s; width: 4px; height: 4px; }
    #player.jk48 .jk48-tube i:nth-child(3) { animation-delay: -1.3s; }
    #player.jk48 .jk48-tube i:nth-child(4) { animation-delay: -1.9s; width: 6px; height: 6px; margin-left: -3px; }
    #player.jk48 .jk48-tube i:nth-child(5) { animation-delay: -2.5s; width: 4px; height: 4px; }
    #player.jk48 .jk48-tube i:nth-child(6) { animation-delay: -3s; }
    #player.jk48 .jk48-right .jk48-tube i { animation-duration: 3.9s; }

    /* the glass dome over the record changer */
    #player.jk48 .jk48-dome {
      grid-area: dome;
      position: relative;
      width: 232px;
      height: 240px;
      padding: 5px;
      border-radius: 116px 116px 14px 14px;
      background: var(--jk48-chrome-side);
      box-shadow: 0 0 0 2px #2a1206, 0 4px 10px rgba(0, 0, 0, 0.5);
    }
    #player.jk48 .jk48-dome-inner {
      position: relative;
      width: 222px;
      height: 230px;
      border-radius: 111px 111px 10px 10px;
      overflow: hidden;
      background:
        radial-gradient(ellipse 70% 40% at 50% 0%, rgba(255, 214, 140, 0.55), transparent 70%),
        radial-gradient(circle at 50% 58%, #4a1118 0%, #2a070c 55%, #160305 100%);
      box-shadow: inset 0 0 18px rgba(0, 0, 0, 0.85);
    }
    #player.jk48 .jk48-platter {
      position: absolute;
      left: 15px;
      top: 32px;
      width: 192px;
      height: 192px;
      border-radius: 50%;
      background: radial-gradient(circle, #555 0 60%, #c8ccd1 61%, #f5f6f7 66%, #8b9097 72%, #3a3d41 100%);
      box-shadow: 0 6px 14px rgba(0, 0, 0, 0.7);
    }
    #player.jk48 .jk48-slot {
      position: absolute;
      left: 18px;
      top: 35px;
      width: 186px;
      height: 186px;
    }
    #player.jk48 .jk48-record {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      background:
        radial-gradient(circle, transparent 0 89px, #262626 89px 91px, #0b0b0b 91px),
        radial-gradient(circle, transparent 0 46px, rgba(255, 255, 255, 0.05) 46px 47px, #151515 47px 49px, transparent 49px),
        repeating-radial-gradient(circle, #111 0 1px, #1c1c1c 1px 2px, #0d0d0d 2px 3px);
      box-shadow: 0 0 0 1px #000, 0 4px 10px rgba(0, 0, 0, 0.6);
      animation: jk48-spin var(--jk48-turn) linear infinite;
      animation-play-state: paused;
      will-change: transform;
    }
    #player.jk48.is-playing .jk48-record {
      animation-play-state: running;
    }
    #player.jk48 .jk48-label {
      --jk48-label-bg: #7a1424;
      position: absolute;
      left: 50%;
      top: 50%;
      width: 72px;
      height: 72px;
      margin: -36px 0 0 -36px;
      border-radius: 50%;
      overflow: hidden;
      background: radial-gradient(circle, rgba(255, 255, 255, 0.08), transparent 70%), var(--jk48-label-bg);
      box-shadow: inset 0 0 0 3px var(--jk48-label-bg), inset 0 0 0 4px #e3c77e, 0 0 0 1px #000;
      color: #ecd38c;
    }
    #player.jk48 .jk48-label-print {
      position: absolute;
      inset: 6px;
      display: grid;
      grid-template-rows: minmax(0, 1fr) 12px minmax(0, 1fr);
      justify-items: center;
      padding: 4px;
      text-align: center;
      font-family: Georgia, "Times New Roman", serif;
      font-size: 6.5px;
      line-height: 1.1;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    #player.jk48 .jk48-label-top {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-end;
      gap: 1px;
      min-height: 0;
    }
    #player.jk48 .jk48-label-rpm {
      font-size: 5px;
      letter-spacing: 0.12em;
      opacity: 0.85;
    }
    #player.jk48 .jk48-label-title {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      overflow-wrap: anywhere;
      max-width: 52px;
      font-weight: bold;
    }
    #player.jk48 .jk48-label-artist {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      align-self: start;
      overflow: hidden;
      overflow-wrap: anywhere;
      max-width: 50px;
      font-style: italic;
      text-transform: none;
      font-size: 6px;
    }
    #player.jk48 .jk48-label #cover {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      border-radius: 50%;
    }
    #player.jk48 .jk48-label #cover[hidden] {
      display: none;
    }
    #player.jk48 .jk48-label.has-cover .jk48-label-print {
      display: none;
    }
    #player.jk48 .jk48-sheen {
      position: absolute;
      left: 18px;
      top: 35px;
      width: 186px;
      height: 186px;
      border-radius: 50%;
      pointer-events: none;
      background: conic-gradient(from 200deg, transparent 0deg, rgba(255, 255, 255, 0.14) 22deg, transparent 50deg, transparent 180deg, rgba(255, 236, 210, 0.1) 202deg, transparent 232deg);
      -webkit-mask: radial-gradient(circle, transparent 0 37px, #000 38px 92px, transparent 93px);
      mask: radial-gradient(circle, transparent 0 37px, #000 38px 92px, transparent 93px);
    }
    #player.jk48 .jk48-spindle {
      position: absolute;
      left: 107px;
      top: 124px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: radial-gradient(circle at 35% 35%, #fff, #a9adb3 55%, #4b4f55);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
    }
    #player.jk48 .jk48-arm {
      position: absolute;
      left: 178px;
      top: 44px;
      width: 0;
      height: 0;
      transform: rotate(var(--jk48-arm-rest));
      transition: transform 0.9s cubic-bezier(0.3, 0.7, 0.3, 1);
      filter: drop-shadow(3px 5px 3px rgba(0, 0, 0, 0.6));
    }
    #player.jk48.is-playing:not(.is-swapping) .jk48-arm {
      transform: rotate(var(--jk48-arm-play));
    }
    #player.jk48 .jk48-arm-rod {
      position: absolute;
      left: -4px;
      top: 0;
      width: 8px;
      height: 112px;
      border-radius: 4px;
      background: linear-gradient(90deg, #7d8289, #f6f7f8 45%, #aeb3b9 70%, #6f747b);
    }
    #player.jk48 .jk48-arm-head {
      position: absolute;
      left: -8px;
      top: 100px;
      width: 16px;
      height: 24px;
      border-radius: 3px 3px 6px 6px;
      background: linear-gradient(90deg, #2b2b2b, #5a5a5a 45%, #1f1f1f);
      box-shadow: inset 0 3px 0 #c9cdd2;
      transform: rotate(14deg);
      transform-origin: 50% 0;
    }
    #player.jk48 .jk48-arm-base {
      position: absolute;
      left: -14px;
      top: -14px;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: radial-gradient(circle at 40% 35%, #fff, #c3c7cc 40%, #6d7279 75%, #3a3d41);
      box-shadow: 0 0 0 2px #2a1206;
    }
    #player.jk48 .jk48-arm-base::after {
      content: "";
      position: absolute;
      left: 9px;
      top: 9px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: radial-gradient(circle at 40% 35%, #8a1a22, #3d070c);
    }
    #player.jk48 .jk48-glass {
      position: absolute;
      inset: 0;
      border-radius: inherit;
      pointer-events: none;
      background:
        linear-gradient(118deg, rgba(255, 255, 255, 0.2) 0%, rgba(255, 255, 255, 0.06) 22%, transparent 34%, transparent 64%, rgba(255, 255, 255, 0.08) 74%, transparent 84%),
        radial-gradient(ellipse 60% 30% at 40% 6%, rgba(255, 255, 255, 0.25), transparent 70%);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18);
    }
    #player.jk48.is-swapping .jk48-slot {
      animation: jk48-swap 0.6s ease-in-out;
    }

    /* centre: marquee, title strip, dial and keys */
    #player.jk48 .jk48-center {
      grid-area: center;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    #player.jk48 .jk48-marquee {
      position: relative;
      flex: 0 0 auto;
      padding: 3px;
      border-radius: 8px;
      background: var(--jk48-chrome);
      box-shadow: 0 0 0 2px #2a1206;
    }
    #player.jk48 .jk48-marquee-glass {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      height: 26px;
      border-radius: 5px;
      background:
        repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.12) 0 1px, transparent 1px 6px),
        radial-gradient(ellipse at center, #fff0b8 0%, #ffc95a 55%, #d27a0c 100%);
      box-shadow: inset 0 0 8px rgba(120, 50, 0, 0.6);
      font-family: var(--jk48-deco);
      font-size: 15px;
      letter-spacing: 0.2em;
      color: var(--jk48-deep-red);
      text-shadow: 0 0 6px rgba(255, 236, 180, 0.9);
      white-space: nowrap;
      overflow: hidden;
      transition: filter 0.4s ease;
    }
    #player.jk48 .jk48-star {
      font-size: 11px;
      color: var(--jk48-red);
    }
    #player.jk48:not(.is-playing) .jk48-marquee-glass {
      filter: brightness(0.82) saturate(0.85);
    }
    #player.jk48.is-error .jk48-marquee-glass {
      color: #fff3d6;
      background:
        repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.06) 0 1px, transparent 1px 6px),
        radial-gradient(ellipse at center, #b3141f 0%, #7d0d16 70%, #4a050b 100%);
      text-shadow: 0 0 4px rgba(0, 0, 0, 0.5);
      filter: none;
    }
    #player.jk48 .jk48-strip {
      position: relative;
      flex: 0 0 auto;
      padding: 4px;
      border-radius: 6px;
      background: var(--jk48-chrome);
      box-shadow: 0 0 0 2px #2a1206, 0 3px 8px rgba(0, 0, 0, 0.4);
    }
    #player.jk48 .jk48-strip-card {
      position: relative;
      overflow: hidden;
      border-radius: 2px;
      background:
        repeating-linear-gradient(0deg, rgba(120, 90, 40, 0.035) 0 1px, transparent 1px 3px),
        linear-gradient(180deg, #fbf5e6, var(--jk48-cream));
      box-shadow: inset 0 0 0 1px #cbb68b;
    }
    #player.jk48 .jk48-strip-card::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: linear-gradient(160deg, rgba(255, 255, 255, 0.35), transparent 35%);
    }
    #player.jk48 .jk48-strip-top {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 50px;
      padding: 4px 12px;
    }
    #player.jk48 #title {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      margin: 0;
      font-family: var(--jk48-type);
      font-size: 18px;
      font-weight: normal;
      line-height: 21px;
      text-align: center;
      color: var(--jk48-ink);
      overflow-wrap: anywhere;
    }
    #player.jk48 .jk48-strip-band {
      min-height: 22px;
      padding: 0 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(180deg, #c42a35, var(--jk48-red) 50%, #8f1520);
      box-shadow: inset 0 1px 0 #5e0b12, inset 0 -1px 0 #5e0b12;
    }
    #player.jk48 #artist {
      margin: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-family: var(--jk48-deco);
      font-size: 13px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #fbf0d4;
    }
    #player.jk48 .jk48-strip-foot {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      height: 18px;
      padding: 2px 8px 0;
      font-family: var(--jk48-type);
      font-size: 11px;
      color: #6b5636;
      white-space: nowrap;
    }
    #player.jk48 #jk48-next {
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    #player.jk48 .jk48-dial-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 0 0 auto;
    }
    #player.jk48 .jk48-time {
      flex: 0 0 40px;
      font-family: var(--jk48-type);
      font-size: 12px;
      color: #f4e3bd;
      text-shadow: 0 1px 1px #000;
      text-align: center;
      font-variant-numeric: tabular-nums;
    }
    #player.jk48 .jk48-dial {
      position: relative;
      flex: 1 1 auto;
      height: 24px;
      padding: 3px;
      border-radius: 5px;
      background: var(--jk48-chrome);
      box-shadow: 0 0 0 2px #2a1206;
      cursor: pointer;
      touch-action: pan-y;
    }
    #player.jk48 .jk48-dial-face {
      position: relative;
      height: 100%;
      border-radius: 3px;
      overflow: hidden;
      background:
        repeating-linear-gradient(90deg, #6b4a1e 0 1px, transparent 1px 10%) bottom / 100% 9px no-repeat,
        repeating-linear-gradient(90deg, rgba(107, 74, 30, 0.7) 0 1px, transparent 1px 2.5%) bottom / 100% 5px no-repeat,
        linear-gradient(180deg, #fff6d8, #f3d58e);
      box-shadow: inset 0 0 6px rgba(140, 80, 0, 0.45);
    }
    #player.jk48 .jk48-dial-fill {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: var(--jk48-progress);
      background: linear-gradient(180deg, rgba(255, 170, 60, 0.35), rgba(255, 120, 30, 0.25));
    }
    #player.jk48 .jk48-needle {
      position: absolute;
      top: -1px;
      bottom: -1px;
      left: var(--jk48-progress);
      width: 3px;
      margin-left: -1.5px;
      border-radius: 1px;
      background: #c0161f;
      box-shadow: 0 0 4px rgba(192, 22, 31, 0.7);
    }
    #player.jk48 .jk48-controls {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex: 1 1 auto;
      min-height: 62px;
      padding: 6px 12px;
      border-radius: 10px;
      background: var(--jk48-chrome);
      box-shadow: 0 0 0 2px #2a1206, inset 0 2px 0 rgba(255, 255, 255, 0.7);
    }
    #player.jk48 .jk48-volume {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    #player.jk48 .jk48-volume-stack {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
    }
    #player.jk48 .jk48-knob {
      position: relative;
      width: 38px;
      height: 38px;
      border-radius: 50%;
      background: repeating-conic-gradient(#2f0c05 0 7deg, #6a2410 7deg 14deg);
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.6), 0 0 0 1px #1a0702;
      cursor: ns-resize;
      touch-action: none;
    }
    #player.jk48 .jk48-knob::before {
      content: "";
      position: absolute;
      inset: 4px;
      border-radius: 50%;
      background: radial-gradient(circle at 35% 30%, #b0583a, #6b1c0d 55%, #2c0a03);
      box-shadow: inset 0 1px 1px rgba(255, 200, 170, 0.5);
    }
    #player.jk48 .jk48-knob-pointer {
      position: absolute;
      inset: 4px;
      border-radius: 50%;
      transform: rotate(var(--jk48-knob));
      transition: transform 0.15s ease;
    }
    #player.jk48 .jk48-knob-pointer::after {
      content: "";
      position: absolute;
      left: 50%;
      top: 3px;
      width: 3px;
      height: 11px;
      margin-left: -1.5px;
      border-radius: 2px;
      background: #f3e2b8;
    }
    #player.jk48 .jk48-small {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: radial-gradient(circle at 40% 35%, #fffaf0, #e8dbbb 60%, #b9a57a);
      box-shadow: 0 2px 0 #6b5532, 0 3px 4px rgba(0, 0, 0, 0.4);
      font-family: var(--jk48-deco);
      font-size: 15px;
      line-height: 1;
      color: var(--jk48-deep-red);
      transition: transform 0.08s ease, box-shadow 0.08s ease;
    }
    #player.jk48 .jk48-keys {
      display: flex;
      gap: 8px;
    }
    #player.jk48 .jk48-key {
      width: 62px;
      height: 46px;
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 3px;
      border-radius: 4px 4px 9px 9px;
      background: linear-gradient(180deg, #fffaf0 0%, #f1e5c8 65%, #d8c69c 100%);
      border: 1px solid #8a7550;
      box-shadow: 0 4px 0 #6b5532, 0 6px 8px rgba(0, 0, 0, 0.45), inset 0 1px 0 #fff;
      color: var(--jk48-deep-red);
      transition: transform 0.08s ease, box-shadow 0.08s ease;
    }
    #player.jk48 .jk48-key-play {
      width: 70px;
      background: linear-gradient(180deg, #e0525a 0%, var(--jk48-red) 60%, #85131d 100%);
      border-color: #4d0910;
      box-shadow: 0 4px 0 #4d0910, 0 6px 8px rgba(0, 0, 0, 0.45), inset 0 1px 0 #f59a9f;
      color: #fff3d6;
    }
    #player.jk48 .jk48-icon {
      width: 18px;
      height: 18px;
      fill: currentColor;
    }
    #player.jk48 .jk48-key-play .jk48-icon-pause,
    #player.jk48 .jk48-key-play.is-on .jk48-icon-play {
      display: none;
    }
    #player.jk48 .jk48-key-play.is-on .jk48-icon-pause {
      display: block;
    }
    #player.jk48 .jk48-caption {
      font-family: var(--jk48-deco);
      font-size: 9px;
      letter-spacing: 0.12em;
      line-height: 1;
    }
    #player.jk48 .jk48-volume .jk48-caption {
      color: var(--jk48-deep-red);
    }
    #player.jk48 .jk48-key:active,
    #player.jk48 .jk48-key.is-pressed {
      transform: translateY(3px);
      box-shadow: 0 1px 0 #6b5532, 0 2px 3px rgba(0, 0, 0, 0.45), inset 0 1px 0 #fff;
    }
    #player.jk48 .jk48-key-play:active,
    #player.jk48 .jk48-key-play.is-pressed {
      box-shadow: 0 1px 0 #4d0910, 0 2px 3px rgba(0, 0, 0, 0.45), inset 0 1px 0 #f59a9f;
    }
    #player.jk48 .jk48-small:active,
    #player.jk48 .jk48-small.is-pressed {
      transform: translateY(2px);
      box-shadow: 0 0 0 #6b5532, 0 1px 2px rgba(0, 0, 0, 0.4);
    }

    /* program of selections */
    #player.jk48 .jk48-program {
      grid-area: program;
      min-width: 0;
      display: flex;
      flex-direction: column;
      padding: 4px;
      border-radius: 8px;
      background: var(--jk48-chrome);
      box-shadow: 0 0 0 2px #2a1206;
    }
    #player.jk48 .jk48-program-head {
      flex: 0 0 auto;
      padding: 3px 0 4px;
      text-align: center;
      font-family: var(--jk48-deco);
      font-size: 13px;
      letter-spacing: 0.25em;
      color: var(--jk48-deep-red);
      text-shadow: 0 1px 0 rgba(255, 255, 255, 0.7);
    }
    #player.jk48 .jk48-program-list {
      flex: 1 1 auto;
      min-height: 0;
      height: 0;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 5px;
      padding: 6px;
      border-radius: 5px;
      background: linear-gradient(180deg, #2a0f06, #3d1a0b);
      box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.8);
      scrollbar-width: thin;
      scrollbar-color: #b9a57a #2a0f06;
    }
    #player.jk48 .jk48-pick {
      display: flex;
      align-items: stretch;
      width: 100%;
      min-height: 34px;
      border-radius: 2px;
      overflow: hidden;
      text-align: left;
      background:
        repeating-linear-gradient(0deg, rgba(120, 90, 40, 0.035) 0 1px, transparent 1px 3px),
        var(--jk48-cream);
      box-shadow: inset 0 0 0 1px #cbb68b;
      transition: background-color 0.2s ease, box-shadow 0.2s ease, filter 0.2s ease;
    }
    #player.jk48 .jk48-pick:hover {
      filter: brightness(1.05);
    }
    #player.jk48 .jk48-pick-no {
      flex: 0 0 26px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(180deg, #c42a35, var(--jk48-red) 50%, #8f1520);
      font-family: var(--jk48-deco);
      font-size: 13px;
      color: #fbf0d4;
    }
    #player.jk48 .jk48-pick-words {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      flex-direction: column;
      justify-content: center;
      padding: 2px 7px;
    }
    #player.jk48 .jk48-pick-title,
    #player.jk48 .jk48-pick-artist {
      display: block;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    #player.jk48 .jk48-pick-title {
      font-family: var(--jk48-type);
      font-size: 12px;
      color: var(--jk48-ink);
    }
    #player.jk48 .jk48-pick-artist {
      font-family: var(--jk48-deco);
      font-size: 8.5px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: #8a1c1c;
    }
    #player.jk48 .jk48-pick.is-current {
      background:
        repeating-linear-gradient(0deg, rgba(120, 60, 0, 0.04) 0 1px, transparent 1px 3px),
        radial-gradient(ellipse at 50% 50%, #fff2c2, #ffcf6b);
      box-shadow: inset 0 0 0 1px #d18a1c, 0 0 9px rgba(255, 196, 90, 0.85);
    }
    #player.jk48 .jk48-pick.is-current .jk48-pick-no {
      background: linear-gradient(180deg, #ffd36a, #f0a22a);
      color: var(--jk48-deep-red);
    }

    /* paused jukeboxes glow a little dimmer */
    #player.jk48 .jk48-shade {
      position: absolute;
      inset: 0;
      z-index: 1;
      background: rgba(40, 10, 0, 0.3);
      opacity: 0;
      transition: opacity 0.6s ease;
      pointer-events: none;
    }
    #player.jk48:not(.is-playing) .jk48-shade {
      opacity: 1;
    }

    /* narrower pages: program moves under the dome and the keys */
    @container (max-width: 950px) {
      #player.jk48 .jk48-body {
        grid-template-columns: 232px minmax(0, 1fr);
        grid-template-areas: "dome center" "program program";
      }
      #player.jk48 .jk48-program-list {
        height: auto;
        max-height: 128px;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
      }
    }
    @container (max-width: 720px) {
      #player.jk48 .jk48-cabinet {
        gap: 6px;
        padding: 8px;
      }
      #player.jk48 .jk48-pilaster {
        flex-basis: 18px;
      }
      #player.jk48 .jk48-tube {
        width: 8px;
        margin-left: -4px;
      }
      #player.jk48 .jk48-body {
        grid-template-columns: minmax(0, 1fr);
        grid-template-areas: "dome" "center" "program";
      }
      #player.jk48 .jk48-dome {
        justify-self: center;
      }
      #player.jk48 .jk48-controls {
        flex-wrap: wrap;
        justify-content: center;
      }
      #player.jk48 .jk48-program-list {
        grid-template-columns: minmax(0, 1fr);
      }
    }
    @container (max-width: 360px) {
      #player.jk48 .jk48-key {
        width: 54px;
      }
      #player.jk48 .jk48-key-play {
        width: 60px;
      }
      #player.jk48 .jk48-keys {
        gap: 6px;
      }
    }

    @container (max-width: 300px) {
      #player.jk48 .jk48-pilaster {
        display: none;
      }
    }

    /* Windows high contrast: keep the dial, knob and current pick visible */
    @media (forced-colors: active) {
      #player.jk48 .jk48-dial,
      #player.jk48 .jk48-knob,
      #player.jk48 .jk48-small {
        border: 1px solid ButtonText;
      }
      #player.jk48 .jk48-needle,
      #player.jk48 .jk48-knob-pointer::after {
        forced-color-adjust: none;
        background: Highlight;
      }
      #player.jk48 .jk48-pick.is-current {
        outline: 2px solid Highlight;
        outline-offset: -2px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      #player.jk48 .jk48-pilaster,
      #player.jk48 .jk48-tube i,
      #player.jk48 .jk48-record,
      #player.jk48.is-swapping .jk48-slot {
        animation: none;
      }
      #player.jk48 .jk48-tube i {
        display: none;
      }
      #player.jk48 .jk48-arm {
        transition: none;
      }
    }

    @keyframes jk48-spin {
      to { transform: rotate(360deg); }
    }
    @keyframes jk48-glow {
      0% { filter: hue-rotate(0deg) brightness(1); }
      50% { filter: hue-rotate(28deg) brightness(1.08); }
      100% { filter: hue-rotate(70deg) brightness(0.96); }
    }
    @keyframes jk48-bubble {
      0% { top: 100%; opacity: 0; }
      10% { opacity: 1; }
      90% { opacity: 1; }
      100% { top: -6%; opacity: 0; }
    }
    @keyframes jk48-swap {
      0% { transform: translateY(0) scale(1); opacity: 1; }
      45% { transform: translateY(-14px) scale(0.86); opacity: 0; }
      55% { transform: translateY(-14px) scale(0.86); opacity: 0; }
      100% { transform: translateY(0) scale(1); opacity: 1; }
    }
    `;
    document.head.appendChild(style);
  }

  function buildPlayer() {
    const player = document.createElement("div");
    player.id = "player";
    player.className = "jk48";
    player.setAttribute("role", "region");
    player.setAttribute("aria-label", "Jukebox music player");
    player.innerHTML = `
      <div class="jk48-cabinet">
        <div class="jk48-pilaster jk48-left" aria-hidden="true"><div class="jk48-tube">${bubbles()}</div><span class="jk48-shade"></span></div>
        <div class="jk48-body">
          <div class="jk48-dome" aria-hidden="true">
            <div class="jk48-dome-inner">
              <div class="jk48-platter"></div>
              <div class="jk48-slot">
                <div class="jk48-record">
                  <div class="jk48-label" id="jk48-label">
                    <div class="jk48-label-print">
                      <div class="jk48-label-top">
                        <span class="jk48-label-rpm">78 R.P.M.</span>
                        <span class="jk48-label-title" id="jk48-label-title"></span>
                      </div>
                      <span class="jk48-label-hole"></span>
                      <span class="jk48-label-artist" id="jk48-label-artist"></span>
                    </div>
                    <img id="cover" alt="" hidden>
                  </div>
                </div>
              </div>
              <div class="jk48-sheen"></div>
              <div class="jk48-spindle"></div>
              <div class="jk48-arm">
                <div class="jk48-arm-rod"></div>
                <div class="jk48-arm-head"></div>
                <div class="jk48-arm-base"></div>
              </div>
              <div class="jk48-glass"></div>
            </div>
          </div>

          <div class="jk48-center">
            <div class="jk48-marquee">
              <div class="jk48-marquee-glass">
                <span class="jk48-star" aria-hidden="true">&#9733;</span>
                <span id="jk48-status" role="status">PAUSED</span>
                <span class="jk48-star" aria-hidden="true">&#9733;</span>
              </div>
            </div>
            <div class="jk48-strip">
              <div class="jk48-strip-card" aria-live="polite">
                <div class="jk48-strip-top"><h3 id="title"></h3></div>
                <div class="jk48-strip-band"><p id="artist"></p></div>
                <div class="jk48-strip-foot">
                  <span id="jk48-selection"></span>
                  <span id="jk48-next"></span>
                </div>
              </div>
            </div>
            <div class="jk48-dial-row">
              <span class="jk48-time" id="jk48-elapsed">0:00</span>
              <div class="jk48-dial" id="progress-bar" role="slider" tabindex="0" aria-label="Song position" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
                <div class="jk48-dial-face">
                  <div class="jk48-dial-fill"></div>
                  <div class="jk48-needle"></div>
                </div>
              </div>
              <span class="jk48-time" id="jk48-duration">-:--</span>
            </div>
            <div class="jk48-controls" id="controls">
              <div class="jk48-volume">
                <button type="button" class="jk48-small" id="volumeDownButton" aria-label="Volume down" title="Softer">&minus;</button>
                <div class="jk48-volume-stack">
                  <div class="jk48-knob" id="jk48-knob" role="slider" tabindex="0" aria-label="Volume" aria-valuemin="0" aria-valuemax="20" aria-valuenow="${currentVolume}">
                    <div class="jk48-knob-pointer"></div>
                  </div>
                  <span class="jk48-caption">VOLUME</span>
                </div>
                <button type="button" class="jk48-small" id="volumeUpButton" aria-label="Volume up" title="Louder">+</button>
              </div>
              <div class="jk48-keys">
                <button type="button" class="jk48-key" id="prevButton" aria-label="Back (previous record)" title="Previous record">${icon("prev")}<span class="jk48-caption">BACK</span></button>
                <button type="button" class="jk48-key jk48-key-play" id="playPauseButton" aria-label="Play" title="Play">${icon("play")}${icon("pause")}<span class="jk48-caption">PLAY</span></button>
                <button type="button" class="jk48-key" id="nextButton" aria-label="Reject (next record)" title="Reject: skip to the next record">${icon("next")}<span class="jk48-caption">REJECT</span></button>
              </div>
            </div>
          </div>

          <div class="jk48-program">
            <div class="jk48-program-head" id="jk48-program-head">SELECTIONS</div>
            <ol class="jk48-program-list" id="jk48-program" aria-labelledby="jk48-program-head"></ol>
          </div>
        </div>
        <div class="jk48-pilaster jk48-right" aria-hidden="true"><div class="jk48-tube">${bubbles()}</div><span class="jk48-shade"></span></div>
      </div>
    `;
    return player;
  }

  function wireDial(dial) {
    let dragging = false;
    let dragSong = null;

    const ratioAt = (clientX) => {
      const rect = dial.getBoundingClientRect();
      if (!rect.width) return 0;
      return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
    };

    const preview = (ratio) => {
      const duration = backendGetDuration();
      paintDial(ratio, ratio * duration, duration);
    };

    dial.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      const duration = backendGetDuration();
      if (!Number.isFinite(duration) || duration <= 0) return;
      dragging = true;
      dragSong = currentSong();
      seeking = true;
      try { dial.setPointerCapture(e.pointerId); } catch (err) {}
      preview(ratioAt(e.clientX));
      e.preventDefault();
    });

    dial.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      preview(ratioAt(e.clientX));
    });

    const finish = (e, commit) => {
      if (!dragging) return;
      dragging = false;
      const duration = backendGetDuration();
      // if the record changed mid-drag, don't seek the new one
      if (commit && currentSong() === dragSong && Number.isFinite(duration) && duration > 0) {
        backendSeekTo(ratioAt(e.clientX) * duration);
      }
      dragSong = null;
      seeking = false;
      paintProgress(backendGetCurrentTime(), backendGetDuration());
    };
    dial.addEventListener("pointerup", (e) => finish(e, true));
    dial.addEventListener("pointercancel", (e) => finish(e, false));

    dial.addEventListener("keydown", (e) => {
      const duration = backendGetDuration();
      if (!Number.isFinite(duration) || duration <= 0) return;
      const now = backendGetCurrentTime();
      let target = null;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") target = now + 5;
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") target = now - 5;
      else if (e.key === "PageUp") target = now + 30;
      else if (e.key === "PageDown") target = now - 30;
      else if (e.key === "Home") target = 0;
      else if (e.key === "End") target = Math.max(duration - 1, 0);
      if (target === null) return;
      e.preventDefault();
      target = Math.min(Math.max(target, 0), duration);
      backendSeekTo(target);
      paintProgress(target, duration);
    });
  }

  function wireKnob(knob) {
    let dragY = null;
    let dragLevel = currentVolume;

    knob.addEventListener("keydown", (e) => {
      let level = null;
      if (e.key === "ArrowUp" || e.key === "ArrowRight") level = currentVolume + 1;
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft") level = currentVolume - 1;
      else if (e.key === "PageUp") level = currentVolume + 5;
      else if (e.key === "PageDown") level = currentVolume - 5;
      else if (e.key === "Home") level = 0;
      else if (e.key === "End") level = 20;
      if (level === null) return;
      e.preventDefault();
      setVolumeLevel(level);
    });

    // the wheel turns the knob only once it's been clicked or tabbed to, so scrolling
    // past it never changes the volume. One step per notch, or per 100px of trackpad.
    let wheelTotal = 0;
    let wheelAt = -Infinity;
    knob.addEventListener("wheel", (e) => {
      if (document.activeElement !== knob) return;
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 300 : e.deltaY;
      if (!dy) return;
      const step = dy < 0 ? 1 : -1;
      if ((step > 0 && currentVolume >= 20) || (step < 0 && currentVolume <= 0)) return;
      e.preventDefault();
      if (e.timeStamp - wheelAt > 150) {
        wheelTotal = 0;
        setVolumeLevel(currentVolume + step);
      } else {
        wheelTotal += dy;
        while (wheelTotal <= -100) { setVolumeLevel(currentVolume + 1); wheelTotal += 100; }
        while (wheelTotal >= 100) { setVolumeLevel(currentVolume - 1); wheelTotal -= 100; }
      }
      wheelAt = e.timeStamp;
    }, { passive: false });

    // drag up to turn it up, down to turn it down
    knob.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      dragY = e.clientY;
      dragLevel = currentVolume;
      try { knob.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
      knob.focus();
    });
    knob.addEventListener("pointermove", (e) => {
      if (dragY === null) return;
      setVolumeLevel(dragLevel + (dragY - e.clientY) / 6);
    });
    const end = () => { dragY = null; };
    knob.addEventListener("pointerup", end);
    knob.addEventListener("pointercancel", end);
  }

  // setup
  function setupMusicPlayer() {
    const gameWindow = document.getElementById("game_window");
    if (!gameWindow) {
      console.warn("game_window element not found. Player will not be attached.");
      return;
    }

    // prevent duplicate players
    if (document.getElementById("player")) return;

    if (activePlaylist.songs.length === 0) {
      JUKEBOX_SONGS.forEach(data => activePlaylist.addSong(new Song(...data)));
    }

    injectStyles();
    const player = buildPlayer();
    gameWindow.insertAdjacentElement("afterend", player);

    // set up audio & logic
    const audio = getAudioElement();
    backendSetVolume(audio, currentVolume / 20);
    paintVolume();

    const playPauseBtn = el("playPauseButton");
    const prevBtn = el("prevButton");
    const nextBtn = el("nextButton");
    const volumeUpBtn = el("volumeUpButton");
    const volumeDownBtn = el("volumeDownButton");

    // keys the jukebox uses shouldn't also work the game's keyboard shortcuts
    player.addEventListener("keydown", (e) => {
      if (e.defaultPrevented || ((e.key === "Enter" || e.key === " ") && e.target.closest("button"))) e.stopPropagation();
    });
    // a mouse click shouldn't leave focus on a key, so Enter still answers the game's questions
    player.addEventListener("click", (e) => {
      const button = e.target.closest("button");
      if (button && e.detail > 0) button.blur();
    });

    playPauseBtn.addEventListener("click", () => {
      togglePlayPause();
    });

    nextBtn.addEventListener("click", () => {
      pressButton(nextBtn);
      advanceToNextSong();
    });

    prevBtn.addEventListener("click", () => {
      pressButton(prevBtn);
      playPreviousSong();
    });

    volumeUpBtn.addEventListener("click", () => {
      pressButton(volumeUpBtn);
      setVolumeLevel(currentVolume + 1);
    });

    volumeDownBtn.addEventListener("click", () => {
      pressButton(volumeDownBtn);
      setVolumeLevel(currentVolume - 1);
    });

    el("jk48-program").addEventListener("click", (e) => {
      const pick = e.target.closest(".jk48-pick");
      if (!pick) return;
      selectSong(Number(pick.dataset.index));
    });

    wireDial(el("progress-bar"));
    wireKnob(el("jk48-knob"));

    // if the cover art won't load, print a 78 label instead
    el("cover").addEventListener("error", () => {
      const cover = el("cover");
      const link = cover.getAttribute("src");
      if (!link) return;
      brokenCovers.add(link);
      cover.hidden = true;
      cover.removeAttribute("src");
      el("jk48-label").classList.remove("has-cover");
    });

    // keep the jukebox in step with the audio element
    const audioEvent = (handler) => () => {
      if (ytActive()) return;
      handler();
    };
    audio.addEventListener("play", audioEvent(() => {
      isPlaying = true;
      buffering = audio.readyState < 3;
      render();
    }));
    audio.addEventListener("playing", audioEvent(() => {
      isPlaying = true;
      buffering = false;
      render();
    }));
    audio.addEventListener("waiting", audioEvent(() => {
      buffering = true;
      render();
    }));
    audio.addEventListener("pause", audioEvent(() => {
      isPlaying = false;
      buffering = false;
      // something else paused the audio; the end of a song is handled by "ended"
      if (!audio.ended) wantPlaying = false;
      render();
    }));
    audio.addEventListener("ended", audioEvent(() => {
      advanceToNextSong();
    }));
    audio.addEventListener("error", audioEvent(() => {
      if (!audio.getAttribute("src")) return;
      hasError = true;
      isPlaying = false;
      wantPlaying = false;
      buffering = false;
      render();
    }));
    const paintFromAudio = audioEvent(() => paintProgress(backendGetCurrentTime(), backendGetDuration()));
    audio.addEventListener("timeupdate", paintFromAudio);
    audio.addEventListener("durationchange", paintFromAudio);
    audio.addEventListener("loadedmetadata", paintFromAudio);

    // YouTube has no time events, so check in on it a few times a second
    setInterval(() => {
      if (ytActive()) paintProgress(backendGetCurrentTime(), backendGetDuration());
    }, 250);

    // initial play
    updateUI(activePlaylist);
    paintProgress(0, 0);
    backendSetSrcAndLoad(activePlaylist.getCurrentSong(), audio, true);
    render();
  }

  exportApi();
  setupMusicPlayer();
})();
