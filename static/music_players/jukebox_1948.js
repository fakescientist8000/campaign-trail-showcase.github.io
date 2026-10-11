// 1948 Jukebox Music Player
// A late-1940s jukebox take on the music player used in the mod 1932 (and other mods).
// It keeps the same API (Song, Playlist, changePlaylist, updateUI) and the same
// YouTube support, but everything you see is drawn with CSS: a 78 r.p.m. record
// turning behind old glass under an arch of lit plastic with a bubble tube, typed
// title strips, a program with selector buttons, a coin plate, Bakelite keys and a
// volume knob, all with the grain and fade of a 1940s photograph. No image assets needed.
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

  // type a title the way a tired typewriter would: a few letters ride a hair high or low,
  // a few strike lighter or heavier. The same title always comes out the same.
  function typeInto(target, text, seed) {
    let n = (seed * 7919 + 17) % 233280;
    // whole characters, so accents and emoji stay in one piece
    const chars = typeof Intl !== "undefined" && Intl.Segmenter
      ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (part) => part.segment)
      : Array.from(text);
    // only the odd letters get their own span; the rest stay plain text
    let plain = "";
    for (const ch of chars) {
      let look = "";
      if (ch !== " ") {
        n = (n * 9301 + 49297) % 233280;
        const r = n / 233280;
        if (r < 0.14) look = "jk48-hi";
        else if (r > 0.9) look = "jk48-lo";
        else if (r > 0.82) look = "jk48-faint";
        else if (r > 0.76) look = "jk48-heavy";
      }
      if (!look) {
        plain += ch;
        continue;
      }
      if (plain) target.appendChild(document.createTextNode(plain));
      plain = "";
      const letter = document.createElement("span");
      letter.className = look;
      letter.textContent = ch;
      target.appendChild(letter);
    }
    if (plain) target.appendChild(document.createTextNode(plain));
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
      typeInto(title, textOf(song?.getTitle?.(), "Untitled"), i);
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

  // bubbles for the tube that runs up both sides of the crown and over the arch:
  // an uneven stream of big and little ones, never quite evenly spaced
  function bubbles() {
    let seed = 46;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const side = (name, period) => {
      let html = "";
      let at = 0;
      for (let i = 0; i < 10; i++) {
        at += period / 10 * (0.55 + rand() * 0.9);
        const size = (3.4 + rand() * rand() * 4).toFixed(1);
        html += '<i style="--jk48-b-delay:-' + (at % period).toFixed(2) + "s;--jk48-b-size:" + size + 'px"></i>';
      }
      return '<span class="jk48-bubbles jk48-bubbles-' + name + '" style="--jk48-b-time:' + period + 's">' + html + "</span>";
    };
    return side("left", 6.2) + side("right", 6.9);
  }

  // small SVG textures, drawn once by the browser: film grain, age stains, wood figure
  function svgUrl(w, h, body) {
    const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='" + w + "' height='" + h + "' viewBox='0 0 " + w + " " + h + "' preserveAspectRatio='none'>" + body + "</svg>";
    return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
  }

  function textures() {
    const filter = (id, body) => "<filter id='" + id + "' x='0' y='0' width='1' height='1' color-interpolation-filters='sRGB'>" + body + "</filter>";

    // the faintest film grain, so it reads as the grain of a print, not speckle
    const grain = svgUrl(160, 160, filter("g",
      "<feTurbulence type='fractalNoise' baseFrequency='1.2' numOctaves='2' seed='3' stitchTiles='stitch' result='n'/>" +
      "<feColorMatrix in='n' result='d' values='0 0 0 0 .15  0 0 0 0 .08  0 0 0 0 .03  .4 0 0 0 -.26'/>" +
      "<feColorMatrix in='n' result='l' values='0 0 0 0 1  0 0 0 0 .94  0 0 0 0 .82  -.4 0 0 0 .14'/>" +
      "<feMerge><feMergeNode in='d'/><feMergeNode in='l'/></feMerge>") +
      "<rect width='160' height='160' filter='url(#g)'/>");

    // two fine scratches and a hair on the old glass, well away from any lettering
    const scratches = svgUrl(222, 230,
      "<path d='M38 74c34-21 71-37 112-46' stroke='#f2e2c0' stroke-width='.5' fill='none' opacity='.2'/>" +
      "<path d='M120 196c26-9 48-24 66-44' stroke='#f2e2c0' stroke-width='.4' fill='none' opacity='.16'/>" +
      "<path d='M58 150c5 12 2 22 9 31' stroke='#f2e2c0' stroke-width='.45' fill='none' opacity='.22'/>");

    // age on old card: a faint tide-mark stain
    const foxing = svgUrl(240, 120, filter("f",
      "<feTurbulence type='fractalNoise' baseFrequency='.03' stitchTiles='stitch' numOctaves='3' seed='7'/>" +
      "<feColorMatrix values='0 0 0 0 .5  0 0 0 0 .32  0 0 0 0 .1  1.6 0 0 0 -.84'/>") +
      "<rect width='240' height='120' filter='url(#f)'/>");

    // tarnish on the nickel and pot metal: dull blotches
    const tarnish = svgUrl(240, 160, filter("t",
      "<feTurbulence type='fractalNoise' baseFrequency='.06 .1' stitchTiles='stitch' numOctaves='3' seed='21'/>" +
      "<feColorMatrix values='0 0 0 0 .22  0 0 0 0 .18  0 0 0 0 .1  1.3 0 0 0 -.64'/>") +
      "<rect width='240' height='160' filter='url(#t)'/>");

    // worn paint: a mask that is solid except where years of fingers have rubbed it away
    const wear = svgUrl(90, 40, filter("r",
      "<feTurbulence type='fractalNoise' baseFrequency='.55' stitchTiles='stitch' numOctaves='2' seed='5'/>" +
      "<feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -9 0 0 0 6.1'/>" +
      "<feComponentTransfer><feFuncA type='linear' slope='.5' intercept='.5'/></feComponentTransfer>") +
      "<rect width='90' height='40' filter='url(#r)'/>");

    // walnut figure: long streaks of darker grain
    const wood = (s) => svgUrl(600, 280, filter("w",
      "<feTurbulence type='fractalNoise' baseFrequency='.0035 .075' numOctaves='4' seed='" + s + "'/>" +
      "<feColorMatrix values='0 0 0 0 .13  0 0 0 0 .06  0 0 0 0 .02  2.6 0 0 0 -1.12'/>") +
      "<rect width='600' height='280' filter='url(#w)'/>");

    return { grain, scratches, foxing, tarnish, wear, woodA: wood(11), woodB: wood(29) };
  }

  function injectStyles() {
    if (el("jk48-styles")) return;

    if (!el("jk48-fonts")) {
      const fonts = document.createElement("link");
      fonts.id = "jk48-fonts";
      fonts.rel = "stylesheet";
      fonts.href = "https://fonts.googleapis.com/css2?family=Alfa+Slab+One&family=Oleo+Script:wght@700&family=Special+Elite&display=swap";
      document.head.appendChild(fonts);
    }

    const tex = textures();
    const style = document.createElement("style");
    style.id = "jk48-styles";
    style.textContent = `
    #player.jk48 {
      --jk48-tarnish: ${tex.tarnish} 0 0 / 240px 160px;
      --jk48-fox-img: ${tex.foxing};
      --jk48-metal: var(--jk48-tarnish), linear-gradient(180deg, #aba693 0%, #a19b89 38%, #948f7d 66%, #86816f 100%);
      --jk48-metal-side: var(--jk48-tarnish), linear-gradient(90deg, #787362 0%, #9c9684 38%, #928c7b 68%, #6c6758 100%);
      --jk48-edge: #24140b;
      --jk48-card: #ebdab0;
      --jk48-ink: #2a1c12;
      --jk48-red: #8a2a1c;
      --jk48-oxblood: #5a1a10;
      --jk48-gold: #f0d590;
      --jk48-sign: "Alfa Slab One", "Rockwell Extra Bold", "Rockwell", Georgia, serif;
      --jk48-type: "Special Elite", "Courier New", Courier, monospace;
      --jk48-script: "Oleo Script", "Brush Script MT", "Segoe Script", cursive;
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
      /* the whole face is printed like a 1940s colour photograph: warm, faded, a little soft */
      filter: sepia(0.3) saturate(0.8);
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
      outline: 2px solid #ffe08f;
      outline-offset: 2px;
    }
    /* on the mid-grey control plate a single colour can't stand out from both the plate and the keys,
       so the ring there is two-tone: a cream halo hugging the control and a dark line outside it */
    #player.jk48 .jk48-controls :focus-visible {
      outline: 3px solid #140802;
      outline-offset: 2px;
    }
    #player.jk48 .jk48-controls .jk48-key:focus-visible::after,
    #player.jk48 .jk48-controls .jk48-small:focus-visible::after,
    #player.jk48 .jk48-controls .jk48-knob:focus-visible::after {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      box-shadow: 0 0 0 2px #f6e7bd;
      pointer-events: none;
    }

    /* the photograph: the faintest grain and one soft vignette over the whole face.
       Each part of the face carries its own piece of the same vignette: --jk48-vx/--jk48-vy say where
       the middle of the whole face sits, measured from that part's corner, so the pieces line up. */
    #player.jk48 .jk48-film {
      --jk48-vx: 50cqw;
      --jk48-vy: 123px;
      --jk48-vw: 60cqw;
      --jk48-vh: 250px;
      position: absolute;
      inset: 0;
      z-index: 20;
      border-radius: inherit;
      pointer-events: none;
      background:
        ${tex.grain} var(--jk48-grain-at, 0 0) / 160px 160px,
        radial-gradient(ellipse var(--jk48-vw) var(--jk48-vh) at var(--jk48-vx) var(--jk48-vy), transparent 46%, rgba(54, 26, 8, 0.14) 70%, rgba(42, 18, 4, 0.4) 100%);
    }
    #player.jk48 .jk48-crown .jk48-film {
      --jk48-vx: 152px;
      --jk48-vy: 165px;
      --jk48-grain-at: -130px -40px;
    }
    #player.jk48 .jk48-wing-program .jk48-film {
      --jk48-vx: -142px;
      --jk48-grain-at: -220px -120px;
    }

    /* the cabinet face: a crown in the middle, two wings either side */
    #player.jk48 .jk48-cabinet {
      position: relative;
      display: flex;
      align-items: flex-end;
      justify-content: center;
    }

    /* the crown: an arch of lit, fluted plastic with a bubble tube running round it */
    #player.jk48 .jk48-crown {
      position: relative;
      z-index: 2;
      isolation: isolate;
      flex: 0 0 304px;
      width: 304px;
      height: 318px;
      overflow: hidden;
      border-radius: 152px 152px 12px 12px;
      background:
        radial-gradient(ellipse 30px 110px at 18px 250px, rgba(255, 232, 160, 0.8), transparent),
        radial-gradient(ellipse 30px 110px at 286px 250px, rgba(255, 232, 160, 0.8), transparent),
        radial-gradient(ellipse 120px 44px at 152px 12px, rgba(255, 236, 170, 0.7), transparent),
        radial-gradient(circle at 152px 152px, transparent 118px, rgba(255, 226, 150, 0.5) 132px, transparent 150px),
        conic-gradient(from 0deg at 152px 152px, #f6cb64, #efa140 52deg, #dc6a32 96deg, #c24a2b 180deg, #dc6a32 264deg, #efa140 308deg, #f6cb64);
      box-shadow: 0 0 0 2px var(--jk48-edge), 0 6px 14px rgba(24, 10, 2, 0.4);
    }
    /* the colour wheel behind the plastic turns slowly, so the arch drifts from red-gold to green-gold */
    #player.jk48 .jk48-crown::before,
    #player.jk48 .jk48-crown::after {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      pointer-events: none;
    }
    #player.jk48 .jk48-crown::before {
      z-index: 0;
      background:
        radial-gradient(ellipse 30px 110px at 18px 250px, rgba(255, 240, 170, 0.7), transparent),
        radial-gradient(ellipse 30px 110px at 286px 250px, rgba(255, 240, 170, 0.7), transparent),
        radial-gradient(circle at 152px 152px, transparent 118px, rgba(255, 236, 160, 0.45) 132px, transparent 150px),
        conic-gradient(from 0deg at 152px 152px, #ead36e, #b7c25e 58deg, #7fa85a 100deg, #e09a3e 180deg, #7fa85a 260deg, #b7c25e 302deg, #ead36e);
      opacity: 0;
      animation: jk48-cycle 11s ease-in-out infinite alternate;
    }
    /* fluting: ribs fan out round the arch and run straight down the sides */
    #player.jk48 .jk48-crown::after {
      z-index: 1;
      background:
        repeating-conic-gradient(from 0deg at 152px 152px, rgba(110, 36, 6, 0.26) 0deg 1.2deg, rgba(255, 240, 200, 0.12) 1.2deg 2.2deg, transparent 2.2deg 5.6deg) 0 0 / 100% 152px no-repeat,
        repeating-linear-gradient(180deg, rgba(110, 36, 6, 0.26) 0 1.5px, rgba(255, 240, 200, 0.12) 1.5px 2.6px, transparent 2.6px 7.4px) 0 152px / 100% 100% no-repeat;
      box-shadow: inset 0 0 0 4px #6c6757, inset 0 0 0 5px rgba(30, 16, 6, 0.85), inset 0 0 12px 4px rgba(90, 30, 0, 0.35);
    }
    #player.jk48 .jk48-crown .jk48-shade {
      z-index: 2;
      border-radius: inherit;
    }
    #player.jk48 .jk48-tube,
    #player.jk48 .jk48-tube-wall {
      position: absolute;
      left: 13px;
      top: 13px;
      width: 278px;
      height: 330px;
      border: 10px solid transparent;
      border-bottom: 0;
      border-radius: 139px 139px 0 0 / 139px 139px 0 0;
      pointer-events: none;
    }
    /* the liquid in the tube, masked to the tube itself */
    #player.jk48 .jk48-tube {
      z-index: 3;
      background:
        radial-gradient(circle at 50% 139px, rgba(60, 8, 0, 0.45) 129px, transparent 132px 136px, rgba(60, 8, 0, 0.45) 139px) 0 0 / 100% 139px no-repeat border-box,
        linear-gradient(90deg, rgba(60, 8, 0, 0.45), transparent 3px 7px, rgba(60, 8, 0, 0.45) 10px, transparent 10px calc(100% - 10px), rgba(60, 8, 0, 0.45) calc(100% - 10px), transparent calc(100% - 7px) calc(100% - 3px), rgba(60, 8, 0, 0.45)) 0 139px / 100% 100% no-repeat border-box,
        conic-gradient(from 0deg at 50% 139px, #e65e30, #cc3f24 70deg, #a52a1a 180deg, #cc3f24 290deg, #e65e30) border-box;
      -webkit-mask: linear-gradient(#000 0 0) padding-box, linear-gradient(#000 0 0);
      -webkit-mask-composite: xor;
      mask: linear-gradient(#000 0 0) padding-box, linear-gradient(#000 0 0);
      mask-composite: exclude;
      opacity: 0.92;
    }
    #player.jk48 .jk48-tube-wall {
      z-index: 5;
      box-shadow: 0 0 0 1.5px rgba(60, 16, 2, 0.75), 0 0 0 3px rgba(255, 236, 190, 0.18), inset 0 0 0 1.5px rgba(60, 16, 2, 0.75);
    }
    #player.jk48 .jk48-bubbles {
      position: absolute;
      left: 152px;
      top: 152px;
      width: 0;
      height: 0;
      z-index: 4;
    }
    #player.jk48 .jk48-bubbles-right {
      transform: scaleX(-1);
    }
    /* an air bubble in coloured liquid: a clear body, a thin bright skin, a darker shadow edge */
    #player.jk48 .jk48-bubbles i {
      --jk48-b-size: 5px;
      position: absolute;
      left: calc(var(--jk48-b-size) / -2);
      top: calc(var(--jk48-b-size) / -2);
      width: var(--jk48-b-size);
      height: var(--jk48-b-size);
      border-radius: 50%;
      background: radial-gradient(circle, rgba(255, 206, 150, 0.22) 0 48%, rgba(246, 214, 168, 0.55) 60% 70%, rgba(90, 20, 4, 0.45) 78%, transparent 84%);
      transform: rotate(-90deg) translateY(-134px) translateX(-170px);
      animation: jk48-bubble var(--jk48-b-time, 6.2s) linear infinite;
      animation-delay: var(--jk48-b-delay, 0s);
    }
    #player.jk48 .jk48-keystone {
      position: absolute;
      left: 134px;
      top: 3px;
      z-index: 7;
      width: 36px;
      height: 27px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 5px 5px 18px 18px / 5px 5px 15px 15px;
      background: var(--jk48-metal);
      box-shadow: 0 0 0 1.5px var(--jk48-edge), 0 2px 3px rgba(20, 8, 0, 0.45), inset 0 -3px 4px rgba(50, 30, 10, 0.35);
      color: var(--jk48-oxblood);
      font-size: 14px;
      line-height: 1;
      padding-bottom: 3px;
    }

    /* the mechanism window: old glass over the record changer */
    #player.jk48 .jk48-dome {
      position: absolute;
      left: 36px;
      top: 36px;
      z-index: 6;
      width: 232px;
      height: 240px;
      padding: 5px;
      border-radius: 116px 116px 10px 10px;
      background: var(--jk48-metal-side);
      box-shadow: 0 0 0 3px var(--jk48-edge), 0 0 0 4px rgba(120, 60, 20, 0.6);
    }
    #player.jk48 .jk48-dome-inner {
      position: relative;
      width: 222px;
      height: 230px;
      border-radius: 111px 111px 7px 7px;
      overflow: hidden;
      background:
        radial-gradient(ellipse 80% 40% at 50% 0%, rgba(255, 206, 128, 0.55), transparent 74%),
        radial-gradient(ellipse 60% 30% at 50% 100%, rgba(255, 170, 90, 0.16), transparent 80%),
        repeating-linear-gradient(90deg, rgba(0, 0, 0, 0.14) 0 2px, transparent 2px 5px),
        radial-gradient(circle at 50% 56%, #6a2818 0%, #3e140c 55%, #210906 100%);
      box-shadow: inset 0 0 18px rgba(0, 0, 0, 0.85);
    }
    #player.jk48 .jk48-platter {
      position: absolute;
      left: 15px;
      top: 32px;
      width: 192px;
      height: 192px;
      border-radius: 50%;
      background: radial-gradient(circle, #3e3833 0 60%, #7d776b 61%, #948e80 66%, #6f695e 72%, #34302b 100%);
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
        radial-gradient(circle, transparent 0 89px, #2a2420 89px 91px, #0e0b09 91px),
        radial-gradient(circle, transparent 0 46px, #1c1714 46px 49px, transparent 49px),
        radial-gradient(circle, transparent 0 84px, rgba(70, 58, 48, 0.25) 84px 85px, transparent 85px),
        repeating-radial-gradient(circle, #15110e 0 1px, #1d1814 1px 2px, #110d0b 2px 3px);
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
      background: var(--jk48-label-bg);
      box-shadow: inset 0 0 0 3px var(--jk48-label-bg), inset 0 0 0 4px #c4a25e, inset 0 0 10px rgba(0, 0, 0, 0.35), 0 0 0 1px #000;
      color: #e3c987;
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
    #player.jk48 .jk48-spindle {
      position: absolute;
      left: 107px;
      top: 124px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #8a8476;
      box-shadow: inset 0 -1px 2px rgba(0, 0, 0, 0.6), 0 1px 2px rgba(0, 0, 0, 0.8);
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
      background: linear-gradient(90deg, #5f5a4f, #9c968a 45%, #858073 70%, #57524a);
    }
    #player.jk48 .jk48-arm-head {
      position: absolute;
      left: -8px;
      top: 100px;
      width: 16px;
      height: 24px;
      border-radius: 3px 3px 6px 6px;
      background: linear-gradient(90deg, #241f1b, #3e3731 45%, #1d1916);
      box-shadow: inset 0 3px 0 #7d776b;
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
      background: radial-gradient(circle, #8f897b 0 50%, #77715f 64%, #575244 100%);
      box-shadow: 0 0 0 2px var(--jk48-edge), inset 0 -2px 3px rgba(0, 0, 0, 0.35);
    }
    #player.jk48 .jk48-arm-base::after {
      content: "";
      position: absolute;
      left: 9px;
      top: 9px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #5c1a12;
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.6);
    }
    /* old glass: a little haze and two fine scratches, no shine */
    #player.jk48 .jk48-glass {
      position: absolute;
      inset: 0;
      border-radius: inherit;
      pointer-events: none;
      background:
        ${tex.scratches} 0 0 / 100% 100% no-repeat,
        radial-gradient(ellipse 95% 30% at 50% 100%, rgba(214, 186, 140, 0.16), transparent 75%),
        radial-gradient(ellipse 34% 22% at 30% 34%, rgba(214, 190, 150, 0.06), transparent 80%),
        radial-gradient(ellipse 26% 30% at 74% 66%, rgba(214, 190, 150, 0.05), transparent 80%);
      box-shadow: inset 0 0 0 1px rgba(30, 14, 4, 0.6), inset 0 0 14px rgba(30, 14, 4, 0.5);
    }
    #player.jk48.is-swapping .jk48-slot {
      animation: jk48-swap 0.6s ease-in-out;
    }
    #player.jk48 .jk48-nameplate {
      position: absolute;
      left: 34px;
      right: 34px;
      top: 281px;
      height: 31px;
      z-index: 6;
      padding: 3px;
      border-radius: 4px 4px 9px 9px;
      background: var(--jk48-metal);
      box-shadow: 0 0 0 1.5px var(--jk48-edge), 0 2px 4px rgba(20, 8, 0, 0.4);
    }
    #player.jk48 .jk48-nameplate span {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      border-radius: 2px 2px 7px 7px;
      background: radial-gradient(ellipse 70% 120% at 50% 40%, #5e2216, #3c140c);
      box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.6);
      font-family: var(--jk48-script);
      font-weight: 700;
      font-size: 15px;
      line-height: 1;
      color: #ecd7a2;
      text-shadow: 0.6px 0.6px 0 rgba(20, 6, 0, 0.6);
      white-space: nowrap;
      transform: rotate(-0.6deg);
    }

    /* the wings: walnut panels edged with a band of lit plastic */
    #player.jk48 .jk48-wing {
      position: relative;
      z-index: 1;
      isolation: isolate;
      flex: 1 1 0;
      min-width: 0;
      height: 276px;
      display: flex;
      padding: 10px 0 0 10px;
      border-radius: 48px 8px 8px 12px;
      background:
        repeating-conic-gradient(from 0deg at 100% 100%, rgba(110, 36, 6, 0.28) 0deg 2deg, transparent 2deg 8deg) 0 0 / 48px 48px no-repeat,
        repeating-linear-gradient(90deg, rgba(110, 36, 6, 0.28) 0 1.6px, transparent 1.6px 7.4px) 48px 0 / 100% 10px no-repeat,
        repeating-linear-gradient(180deg, rgba(110, 36, 6, 0.28) 0 1.6px, transparent 1.6px 7.4px) 0 48px / 10px 100% no-repeat,
        radial-gradient(ellipse 30px 120px at 0 70%, rgba(255, 236, 168, 0.75), transparent),
        radial-gradient(ellipse 120px 26px at 30% 0, rgba(255, 236, 168, 0.6), transparent),
        linear-gradient(180deg, #f2c35e, #e58d3a 45%, #c24e2c);
      box-shadow: 0 0 0 2px var(--jk48-edge), 0 6px 14px rgba(24, 10, 2, 0.35), inset 0 0 0 1px rgba(30, 14, 4, 0.5);
    }
    #player.jk48 .jk48-wing-info {
      margin-right: -10px;
    }
    #player.jk48 .jk48-wing-program {
      margin-left: -10px;
      padding: 10px 10px 0 0;
      border-radius: 8px 48px 12px 8px;
      background:
        repeating-conic-gradient(from 0deg at 0 100%, rgba(110, 36, 6, 0.28) 0deg 2deg, transparent 2deg 8deg) 100% 0 / 48px 48px no-repeat,
        repeating-linear-gradient(90deg, rgba(110, 36, 6, 0.28) 0 1.6px, transparent 1.6px 7.4px) 0 0 / calc(100% - 48px) 10px no-repeat,
        repeating-linear-gradient(180deg, rgba(110, 36, 6, 0.28) 0 1.6px, transparent 1.6px 7.4px) 100% 48px / 10px 100% no-repeat,
        radial-gradient(ellipse 30px 120px at 100% 70%, rgba(255, 236, 168, 0.75), transparent),
        radial-gradient(ellipse 120px 26px at 70% 0, rgba(255, 236, 168, 0.6), transparent),
        linear-gradient(180deg, #f2c35e, #e58d3a 45%, #c24e2c);
    }
    #player.jk48 .jk48-wing::before {
      content: "";
      position: absolute;
      inset: 0;
      z-index: 0;
      border-radius: inherit;
      pointer-events: none;
      background: linear-gradient(180deg, rgba(196, 186, 92, 0.85), rgba(110, 150, 82, 0.8) 50%, rgba(190, 120, 52, 0.8));
      opacity: 0;
      animation: jk48-cycle 11s ease-in-out infinite alternate;
    }
    #player.jk48 .jk48-wing .jk48-shade {
      z-index: 1;
      border-radius: inherit;
    }
    #player.jk48 .jk48-panel {
      position: relative;
      z-index: 2;
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 10px 20px 9px 10px;
      border-radius: 38px 6px 6px 10px;
      background:
        ${tex.woodA} 0 0 / 100% 100%,
        repeating-linear-gradient(178.6deg, rgba(20, 8, 2, 0.12) 0 1px, transparent 1px 6px, rgba(255, 210, 160, 0.04) 6px 7px, transparent 7px 13px),
        radial-gradient(ellipse 60% 40% at 35% 30%, rgba(170, 96, 46, 0.35), transparent 70%),
        linear-gradient(180deg, #75432a 0%, #5f361d 55%, #4a2812 100%);
      box-shadow: 0 0 0 2px var(--jk48-edge), inset 0 0 16px rgba(20, 8, 0, 0.55);
    }
    #player.jk48 .jk48-wing-program .jk48-panel {
      padding: 8px 10px 9px 20px;
      border-radius: 6px 38px 10px 6px;
      background:
        ${tex.woodB} 0 0 / 100% 100%,
        repeating-linear-gradient(181.2deg, rgba(20, 8, 2, 0.12) 0 1px, transparent 1px 7px, rgba(255, 210, 160, 0.04) 7px 8px, transparent 8px 12px),
        radial-gradient(ellipse 60% 40% at 65% 30%, rgba(170, 96, 46, 0.35), transparent 70%),
        linear-gradient(180deg, #75432a 0%, #5f361d 55%, #4a2812 100%);
    }

    /* the lit sign at the top of the left wing, lettered by hand in script with pinstripes either side */
    #player.jk48 .jk48-marquee {
      position: relative;
      flex: 0 0 auto;
      padding: 3px;
      border-radius: 28px 6px 6px 6px;
      background: var(--jk48-metal);
      box-shadow: 0 0 0 1.5px var(--jk48-edge), 0 2px 4px rgba(20, 8, 0, 0.4);
    }
    #player.jk48 .jk48-marquee-glass {
      --jk48-paint: #3a0d05;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 9px;
      height: 28px;
      padding-left: 10px;
      overflow: hidden;
      border-radius: 25px 4px 4px 4px;
      background:
        radial-gradient(ellipse 46% 160% at 50% 60%, rgba(255, 236, 178, 0.9), transparent 74%),
        linear-gradient(180deg, #ebbd66, #dc9a44 60%, #c27a34);
      box-shadow: inset 0 0 10px rgba(90, 34, 0, 0.55);
      white-space: nowrap;
    }
    #player.jk48 .jk48-marquee-glass > span {
      position: relative;
      z-index: 1;
    }
    #player.jk48 #jk48-status {
      display: inline-block;
      padding: 0 2px;
      font-family: var(--jk48-script);
      font-weight: 700;
      font-size: 19px;
      line-height: 28px;
      letter-spacing: 0.01em;
      text-transform: lowercase;
      color: var(--jk48-paint);
      /* a sign painter's thin cream shade under the letters */
      text-shadow: 0.9px 0.9px 0 rgba(255, 238, 196, 0.5);
      transform: rotate(-1.5deg) translateY(-1px);
    }
    #player.jk48 #jk48-status::first-letter {
      text-transform: uppercase;
    }
    #player.jk48 .jk48-swash {
      flex: 0 1 52px;
      min-width: 14px;
      height: 7px;
      background:
        radial-gradient(circle at 2.5px 3.5px, var(--jk48-paint) 0 1.6px, transparent 2.1px) 0 0 / 6px 7px no-repeat,
        linear-gradient(90deg, transparent 6px, var(--jk48-paint) 40%) 0 2px / 100% 1.6px no-repeat,
        linear-gradient(90deg, transparent 30%, var(--jk48-paint) 85%) 0 5px / 100% 1px no-repeat;
      opacity: 0.85;
      transform: rotate(-1.5deg);
    }
    #player.jk48 .jk48-swash-r {
      transform: rotate(-1.5deg) scaleX(-1);
    }
    #player.jk48 .jk48-marquee-glass::after {
      content: "";
      position: absolute;
      inset: 0;
      background: radial-gradient(ellipse 60% 140% at 50% 55%, rgba(60, 22, 0, 0.1), rgba(60, 22, 0, 0.3));
      opacity: 0;
      transition: opacity 0.4s ease;
    }
    #player.jk48:not(.is-playing) .jk48-marquee-glass::after {
      opacity: 1;
    }
    #player.jk48.is-error .jk48-marquee-glass {
      --jk48-paint: #f6e7c4;
      background:
        radial-gradient(ellipse 50% 150% at 50% 70%, rgba(176, 58, 40, 0.8), transparent 72%),
        linear-gradient(180deg, #8a2216, #6c160d 60%, #4c0c06);
    }
    #player.jk48.is-error #jk48-status {
      text-shadow: 0.9px 0.9px 0 rgba(20, 4, 0, 0.6);
    }
    #player.jk48.is-error .jk48-marquee-glass::after {
      opacity: 0;
    }

    /* the title strip, typed on a card and slid into its holder a touch crooked */
    #player.jk48 .jk48-strip {
      position: relative;
      flex: 0 0 auto;
      padding: 4px;
      border-radius: 5px;
      background:
        radial-gradient(circle at 6px 50%, #4f4a3d 0 1.6px, #77715f 2px, transparent 2.6px),
        radial-gradient(circle at calc(100% - 6px) 50%, #4f4a3d 0 1.6px, #77715f 2px, transparent 2.6px),
        var(--jk48-metal);
      box-shadow: 0 0 0 1.5px var(--jk48-edge), 0 3px 6px rgba(20, 8, 0, 0.4);
    }
    #player.jk48 .jk48-strip-card {
      position: relative;
      overflow: hidden;
      margin: 0 6px;
      border-radius: 2px 4px 3px 5px;
      transform: rotate(-0.4deg);
      background:
        radial-gradient(circle at 0 0, rgba(130, 84, 28, 0.3), transparent 20px),
        radial-gradient(circle at 100% 100%, rgba(130, 84, 28, 0.26), transparent 24px),
        radial-gradient(circle at 100% 0, rgba(130, 84, 28, 0.16), transparent 14px),
        radial-gradient(ellipse 60% 80% at 40% 30%, rgba(255, 244, 214, 0.3), transparent 70%),
        var(--jk48-fox-img) -70px -10px / 240px 120px,
        linear-gradient(180deg, #efdfb7, #e5d1a1);
      box-shadow: inset 0 0 0 1px rgba(150, 112, 58, 0.55), inset 0 0 12px rgba(150, 108, 48, 0.25);
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
      text-shadow: 0.35px 0.25px 0 rgba(42, 28, 18, 0.5);
      overflow-wrap: anywhere;
      transform: translateY(0.5px) rotate(0.25deg);
    }
    #player.jk48 .jk48-strip-band {
      min-height: 21px;
      padding: 0 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      background:
        linear-gradient(180deg, rgba(60, 10, 4, 0.35), transparent 2px, transparent calc(100% - 2px), rgba(60, 10, 4, 0.35)),
        var(--jk48-red);
    }
    #player.jk48 #artist {
      margin: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-family: var(--jk48-sign);
      font-size: 13px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #f6e8c6;
      text-shadow: 0.6px 0.4px 0 rgba(30, 4, 0, 0.45);
    }
    #player.jk48 .jk48-strip-foot {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      height: 18px;
      padding: 2px 8px 0;
      font-family: var(--jk48-type);
      font-size: 11px;
      color: #1c1208;
      text-shadow: 0.3px 0.2px 0 rgba(28, 18, 8, 0.5);
      white-space: nowrap;
    }
    #player.jk48 #jk48-next {
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }

    /* the dial, with the time on two little drum counters */
    #player.jk48 .jk48-dial-row {
      display: flex;
      align-items: center;
      gap: 7px;
      flex: 0 0 auto;
    }
    /* ivory number drums turning behind a little window in the metal */
    #player.jk48 .jk48-time {
      flex: 0 0 auto;
      min-width: 44px;
      height: 21px;
      padding: 1px 4px 0 6px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 2px;
      background:
        linear-gradient(180deg, rgba(52, 32, 12, 0.55), rgba(52, 32, 12, 0.05) 26%, transparent 40% 60%, rgba(52, 32, 12, 0.05) 74%, rgba(52, 32, 12, 0.5)),
        linear-gradient(180deg, transparent calc(50% - 0.5px), rgba(90, 60, 24, 0.22) calc(50% - 0.5px) calc(50% + 0.5px), transparent calc(50% + 0.5px)),
        var(--jk48-fox-img) -40px -20px / 240px 120px,
        linear-gradient(180deg, #e6d6ad, #efe2c0 50%, #e2d0a4);
      box-shadow: 0 0 0 2px #6e6958, 0 0 0 3px var(--jk48-edge), inset 0 1px 2px rgba(0, 0, 0, 0.6), inset 0 -1px 1px rgba(0, 0, 0, 0.3);
      font-family: var(--jk48-type);
      font-size: 12.5px;
      line-height: 1;
      letter-spacing: 1.5px;
      color: #120a04;
      text-shadow: 0.3px 0.2px 0 rgba(18, 10, 4, 0.5);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    #player.jk48 .jk48-dial {
      position: relative;
      flex: 1 1 auto;
      min-width: 0;
      height: 30px;
      padding: 3px;
      border-radius: 5px;
      background: var(--jk48-metal);
      box-shadow: 0 0 0 1.5px var(--jk48-edge), 0 2px 4px rgba(20, 8, 0, 0.35);
      cursor: pointer;
      touch-action: pan-y;
    }
    #player.jk48 .jk48-dial-face {
      position: relative;
      height: 100%;
      border-radius: 3px;
      overflow: hidden;
      background:
        repeating-linear-gradient(90deg, #5d3f17 0 1px, transparent 1px 10%) 0 100% / 100% 8px no-repeat,
        repeating-linear-gradient(90deg, rgba(93, 63, 23, 0.7) 0 1px, transparent 1px 2.5%) 0 100% / 100% 4px no-repeat,
        radial-gradient(ellipse 60% 140% at 50% 100%, rgba(255, 238, 190, 0.5), transparent 70%),
        linear-gradient(180deg, #ecd9a6, #dfc184);
      box-shadow: inset 0 0 8px rgba(120, 70, 10, 0.5);
    }
    #player.jk48 .jk48-dial-nums {
      position: absolute;
      left: 0;
      right: 0;
      top: 1px;
      height: 10px;
      font-family: var(--jk48-sign);
      font-size: 8px;
      line-height: 10px;
      color: #4a3010;
    }
    #player.jk48 .jk48-dial-nums i {
      position: absolute;
      top: 0;
      width: 16px;
      margin-left: -8px;
      font-style: normal;
      text-align: center;
    }
    #player.jk48 .jk48-dial-nums i:nth-child(1) { left: 20%; }
    #player.jk48 .jk48-dial-nums i:nth-child(2) { left: 40%; }
    #player.jk48 .jk48-dial-nums i:nth-child(3) { left: 60%; }
    #player.jk48 .jk48-dial-nums i:nth-child(4) { left: 80%; }
    #player.jk48 .jk48-dial-fill {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: var(--jk48-progress);
      background: linear-gradient(90deg, rgba(214, 120, 34, 0.08), rgba(214, 120, 34, 0.32));
    }
    #player.jk48 .jk48-needle {
      position: absolute;
      top: -1px;
      bottom: -1px;
      left: var(--jk48-progress);
      width: 3px;
      margin-left: -1.5px;
      border-radius: 1px;
      background: #8e1d12;
      box-shadow: 1px 0 1px rgba(60, 20, 0, 0.4);
    }

    /* the control plate: Bakelite keys and a volume knob */
    #player.jk48 .jk48-controls {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex: 1 1 auto;
      min-height: 60px;
      padding: 6px 10px 6px 12px;
      border-radius: 6px;
      background:
        radial-gradient(circle at 6px 7px, #514b3e 0 1.6px, #6f6958 2px, transparent 2.6px),
        radial-gradient(circle at 6px calc(100% - 7px), #514b3e 0 1.6px, #6f6958 2px, transparent 2.6px),
        radial-gradient(circle at calc(100% - 6px) 7px, #514b3e 0 1.6px, #6f6958 2px, transparent 2.6px),
        radial-gradient(circle at calc(100% - 6px) calc(100% - 7px), #514b3e 0 1.6px, #6f6958 2px, transparent 2.6px),
        var(--jk48-tarnish),
        linear-gradient(180deg, #c3bea9 0%, #b9b39e 45%, #aca690 100%);
      box-shadow: 0 0 0 1.5px var(--jk48-edge), 0 3px 6px rgba(20, 8, 0, 0.35), inset 0 -2px 0 rgba(40, 24, 8, 0.2);
    }
    #player.jk48 .jk48-volume {
      display: flex;
      align-items: center;
      gap: 5px;
    }
    #player.jk48 .jk48-volume-stack {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
    }
    /* the scale painted on the plate round the knob, 0 to 10 */
    #player.jk48 .jk48-knob-scale {
      position: absolute;
      left: 50%;
      top: -5px;
      width: 46px;
      height: 46px;
      margin-left: -23px;
      border-radius: 50%;
      background: repeating-conic-gradient(from -136.2deg, rgba(40, 22, 8, 0.85) 0 2.4deg, transparent 2.4deg 27deg);
      -webkit-mask: radial-gradient(circle, transparent 0 19.5px, #000 20px 23px, transparent 23.5px), conic-gradient(from 137.5deg, transparent 0 85deg, #000 85deg);
      -webkit-mask-composite: source-in;
      mask: radial-gradient(circle, transparent 0 19.5px, #000 20px 23px, transparent 23.5px), conic-gradient(from 137.5deg, transparent 0 85deg, #000 85deg);
      mask-composite: intersect;
      pointer-events: none;
    }
    #player.jk48 .jk48-volume-steps {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    #player.jk48 .jk48-knob {
      position: relative;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: repeating-conic-gradient(#2e1208 0 7deg, #5a2614 7deg 14deg);
      box-shadow: 0 2px 3px rgba(0, 0, 0, 0.55), 0 0 0 1px #1a0702;
      cursor: ns-resize;
      touch-action: none;
    }
    #player.jk48 .jk48-knob::before {
      content: "";
      position: absolute;
      inset: 4px;
      border-radius: 50%;
      background: radial-gradient(circle, #6a2a16 0 45%, #55200f 70%, #3b1508);
      box-shadow: inset 0 -2px 3px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(20, 6, 0, 0.6);
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
      top: 2px;
      width: 3px;
      height: 10px;
      margin-left: -1.5px;
      border-radius: 1px 2px 1px 2px;
      background: #e8d6a8;
    }
    #player.jk48 .jk48-small {
      position: relative;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding-bottom: 1px;
      background:
        radial-gradient(ellipse 60% 50% at 50% 70%, rgba(120, 85, 30, 0.2), transparent 70%),
        var(--jk48-fox-img) -90px -40px / 240px 120px,
        radial-gradient(circle, #e8d6a4 0 52%, #d8c086 74%, #bea067);
      border: 1px solid #6e5530;
      box-shadow: 0 2px 0 #5b4424, 0 3px 4px rgba(0, 0, 0, 0.35);
      font-family: var(--jk48-sign);
      font-size: 17px;
      line-height: 1;
      color: #4a0f07;
      transition: transform 0.08s ease, box-shadow 0.08s ease;
    }
    #player.jk48 .jk48-keys {
      display: flex;
      gap: 7px;
    }
    #player.jk48 .jk48-key {
      position: relative;
      width: 58px;
      height: 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 2px 2px;
      border-radius: 5px 5px 9px 9px;
      background:
        radial-gradient(ellipse 55% 45% at 50% 78%, rgba(118, 84, 30, 0.24), transparent 72%),
        radial-gradient(circle at 12% 18%, rgba(118, 84, 30, 0.16), transparent 9px),
        var(--jk48-fox-img) var(--jk48-fox, 0 0) / 240px 120px,
        linear-gradient(180deg, #e8d6a5 0%, #dcc58d 60%, #c9ad72 100%);
      border: 1px solid #6a512c;
      box-shadow: 0 4px 0 #57401f, 0 6px 7px rgba(0, 0, 0, 0.4), inset 0 -2px 0 rgba(110, 78, 32, 0.32);
      color: #4c1007;
      transform: rotate(var(--jk48-tilt, 0deg));
      transition: transform 0.08s ease, box-shadow 0.08s ease;
    }
    #player.jk48 #prevButton { --jk48-tilt: -0.5deg; --jk48-fox: -40px -10px; --jk48-wear: 0 0; }
    #player.jk48 #nextButton { --jk48-tilt: 0.4deg; --jk48-fox: -150px -60px; --jk48-wear: -46px -14px; }
    #player.jk48 .jk48-key-play {
      --jk48-wear: -20px -22px;
      width: 62px;
      padding-top: 7px;
      background:
        radial-gradient(ellipse 55% 45% at 50% 78%, rgba(30, 6, 0, 0.3), transparent 72%),
        radial-gradient(ellipse 40% 34% at 50% 58%, rgba(255, 210, 160, 0.07), transparent 80%),
        linear-gradient(180deg, #8a2d1d 0%, #722015 60%, #591609 100%);
      border-color: #330b04;
      box-shadow: 0 4px 0 #3a0d05, 0 6px 7px rgba(0, 0, 0, 0.4), inset 0 -2px 0 rgba(30, 6, 0, 0.35);
      color: #f2e1b8;
    }
    /* while it plays the key stays latched down and its pilot jewel glows */
    #player.jk48 .jk48-key-play.is-on {
      transform: translateY(2px);
      box-shadow: 0 2px 0 #3a0d05, 0 3px 4px rgba(0, 0, 0, 0.4), inset 0 2px 4px rgba(20, 4, 0, 0.45);
    }
    #player.jk48 .jk48-key-play::before {
      content: "";
      position: absolute;
      left: 50%;
      top: 5px;
      width: 8px;
      height: 8px;
      margin-left: -4px;
      border-radius: 50%;
      background: radial-gradient(circle at 50% 55%, #6e3418, #3a1608 75%);
      box-shadow: 0 0 0 1.5px #2a0a03, 0 1px 0 rgba(255, 210, 160, 0.12);
      transition: background 0.3s ease, box-shadow 0.3s ease;
    }
    #player.jk48 .jk48-key-play.is-on::before {
      background: radial-gradient(circle at 50% 50%, #ffe3a0, #f3a646 55%, #b9621e);
      box-shadow: 0 0 0 1.5px #2a0a03, 0 0 6px 2px rgba(255, 170, 70, 0.65);
    }
    #player.jk48 .jk48-caption {
      display: inline-block;
      font-family: var(--jk48-sign);
      font-size: 10px;
      letter-spacing: 0.06em;
      line-height: 1;
    }
    /* the paint on the keys is rubbed thin where fingers have pressed them for years */
    #player.jk48 .jk48-key .jk48-caption {
      padding: 1px 0;
      -webkit-mask: ${tex.wear} var(--jk48-wear, 0 0) / 90px 40px;
      mask: ${tex.wear} var(--jk48-wear, 0 0) / 90px 40px;
    }
    /* a little enamel tag riveted under the knob */
    #player.jk48 .jk48-volume .jk48-caption {
      padding: 2px 4px 1px;
      border-radius: 2px;
      background: linear-gradient(180deg, #e2d4ad, #d3c399);
      box-shadow: inset 0 0 0 1px rgba(70, 46, 18, 0.55), 0 1px 0 rgba(30, 16, 4, 0.35);
      font-size: 8px;
      letter-spacing: 0.05em;
      color: #2a1408;
      text-shadow: none;
    }
    #player.jk48 .jk48-key:active,
    #player.jk48 .jk48-key.is-pressed {
      transform: translateY(3px) rotate(var(--jk48-tilt, 0deg));
      box-shadow: 0 1px 0 #57401f, 0 2px 3px rgba(0, 0, 0, 0.45), inset 0 -2px 0 rgba(110, 78, 32, 0.32);
    }
    #player.jk48 .jk48-key-play:active,
    #player.jk48 .jk48-key-play.is-pressed {
      box-shadow: 0 1px 0 #3a0d05, 0 2px 3px rgba(0, 0, 0, 0.45), inset 0 2px 4px rgba(20, 4, 0, 0.45);
    }
    #player.jk48 .jk48-small:active,
    #player.jk48 .jk48-small.is-pressed {
      transform: translateY(2px);
      box-shadow: 0 0 0 #5b4424, 0 1px 2px rgba(0, 0, 0, 0.4);
    }

    /* the program: typed title strips, each with its numbered selector button */
    #player.jk48 .jk48-program {
      min-width: 0;
    }
    #player.jk48 .jk48-program-head {
      flex: 0 0 auto;
      margin: 0;
      text-align: center;
      font-family: var(--jk48-script);
      font-weight: 700;
      font-size: 17px;
      line-height: 20px;
      color: var(--jk48-gold);
      text-shadow: 0.8px 0.8px 0 rgba(20, 6, 0, 0.8), 0 0 4px rgba(20, 6, 0, 0.5);
      transform: rotate(-1deg);
    }
    #player.jk48 .jk48-program-list {
      flex: 1 1 auto;
      min-height: 0;
      height: 0;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 5px 6px;
      border-radius: 4px;
      background:
        repeating-linear-gradient(180deg, transparent 0 33px, rgba(0, 0, 0, 0.25) 33px 34px),
        linear-gradient(180deg, #2a170c, #3a2112);
      box-shadow: 0 0 0 3px #8a8574, 0 0 0 4.5px var(--jk48-edge), inset 0 2px 6px rgba(0, 0, 0, 0.8);
      scrollbar-width: thin;
      scrollbar-color: #b9a57a #2a170c;
    }
    #player.jk48 .jk48-pick {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      min-height: 30px;
      text-align: left;
    }
    #player.jk48 .jk48-pick-no {
      flex: 0 0 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      background:
        radial-gradient(ellipse 60% 50% at 50% 70%, rgba(120, 85, 30, 0.22), transparent 70%),
        radial-gradient(circle, #e6d3a0 0 52%, #d5bc81 74%, #bb9d63);
      box-shadow: 0 0 0 1px #3a2510, 0 2px 0 #2a1808, 0 3px 3px rgba(0, 0, 0, 0.45);
      font-family: var(--jk48-sign);
      font-size: 12px;
      line-height: 1;
      color: #5e170d;
      transition: transform 0.1s ease, box-shadow 0.1s ease;
    }
    /* each title strip: the song typed on yellowed card, the artist printed on a coloured band */
    #player.jk48 .jk48-pick-words {
      --jk48-band: #7a2418;
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      min-height: 29px;
      overflow: hidden;
      border-radius: 2px 3px 2px 4px;
      background:
        radial-gradient(circle at 0 100%, rgba(130, 84, 28, 0.26), transparent 12px),
        radial-gradient(circle at 100% 0, rgba(130, 84, 28, 0.2), transparent 10px),
        var(--jk48-fox-img) var(--jk48-fox, 0 0) / 240px 120px,
        linear-gradient(180deg, #eddcb2, #e2cd9c);
      box-shadow: inset 0 0 0 1px rgba(150, 112, 58, 0.5), 0 1px 1px rgba(0, 0, 0, 0.35);
      transition: box-shadow 0.2s ease;
    }
    /* no two strips were typed, or slid into the rack, quite the same */
    #player.jk48 .jk48-program-list li:nth-child(5n + 1) .jk48-pick-words { transform: rotate(0.35deg); }
    #player.jk48 .jk48-program-list li:nth-child(5n + 2) .jk48-pick-words { transform: rotate(-0.3deg) translateX(1px); --jk48-band: #2f4a30; --jk48-fox: -60px -30px; }
    #player.jk48 .jk48-program-list li:nth-child(5n + 3) .jk48-pick-words { transform: rotate(0.2deg) translateX(-1px); --jk48-band: #2b3652; --jk48-fox: -130px -70px; }
    #player.jk48 .jk48-program-list li:nth-child(5n + 4) .jk48-pick-words { transform: rotate(-0.15deg); --jk48-band: #4c2339; --jk48-fox: -30px -84px; }
    #player.jk48 .jk48-program-list li:nth-child(5n) .jk48-pick-words { transform: rotate(0.4deg) translateX(-0.5px); --jk48-band: #5a3318; --jk48-fox: -170px -10px; }
    #player.jk48 .jk48-pick:hover .jk48-pick-words {
      box-shadow: inset 0 0 0 1px rgba(150, 112, 58, 0.8), 0 0 6px rgba(255, 200, 120, 0.4);
    }
    #player.jk48 .jk48-pick-title,
    #player.jk48 .jk48-pick-artist {
      display: block;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      text-align: center;
    }
    #player.jk48 .jk48-pick-title {
      padding: 2px 7px 1px;
      font-family: var(--jk48-type);
      font-size: 12px;
      line-height: 14px;
      color: var(--jk48-ink);
      text-shadow: 0.3px 0.2px 0 rgba(42, 28, 18, 0.45);
    }
    /* a worn ribbon and a tired typebar: some letters ride a hair high or low, some strike lighter */
    #player.jk48 .jk48-pick-title .jk48-hi { position: relative; top: -0.7px; }
    #player.jk48 .jk48-pick-title .jk48-lo { position: relative; top: 0.6px; }
    #player.jk48 .jk48-pick-title .jk48-faint { color: #4a3826; }
    #player.jk48 .jk48-pick-title .jk48-heavy { text-shadow: 0.5px 0.3px 0 rgba(42, 28, 18, 0.7); }
    #player.jk48 .jk48-pick-artist {
      padding: 1px 7px 0;
      background:
        linear-gradient(180deg, rgba(0, 0, 0, 0.28), transparent 1.5px, transparent calc(100% - 1px), rgba(0, 0, 0, 0.22)),
        var(--jk48-band);
      font-family: var(--jk48-sign);
      font-size: 9px;
      line-height: 11px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: #f1e3bf;
    }
    /* the chosen record's strip is lit from behind and its button stays pressed in */
    #player.jk48 .jk48-pick.is-current .jk48-pick-words {
      background:
        radial-gradient(circle at 0 100%, rgba(130, 70, 10, 0.25), transparent 12px),
        var(--jk48-fox-img) var(--jk48-fox, 0 0) / 240px 120px,
        radial-gradient(ellipse 72% 130% at 50% 30%, #fff0c0, #f6cf7c 60%, #eab052);
      box-shadow: inset 0 0 0 1px #b8761e, 0 0 10px 2px rgba(255, 180, 70, 0.75);
    }
    #player.jk48 .jk48-pick.is-current .jk48-pick-artist {
      background:
        linear-gradient(180deg, rgba(0, 0, 0, 0.22), transparent 1.5px, transparent calc(100% - 1px), rgba(0, 0, 0, 0.18)),
        linear-gradient(rgba(255, 190, 110, 0.16), rgba(255, 190, 110, 0.16)),
        var(--jk48-band);
    }
    #player.jk48 .jk48-pick.is-current .jk48-pick-no {
      transform: translateY(1.5px);
      background: radial-gradient(circle, #f8d888 0 50%, #e8aa48 80%, #c98426);
      box-shadow: 0 0 0 1px #3a2510, 0 0.5px 0 #2a1808, 0 0 8px rgba(255, 180, 70, 0.75);
    }

    /* the coin entry plate */
    #player.jk48 .jk48-coin {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 10px;
      height: 36px;
      margin-top: 3px;
      padding: 3px 12px;
      border-radius: 5px 5px 9px 9px;
      background:
        radial-gradient(circle at 6px 50%, #514b3e 0 1.6px, #6f6958 2px, transparent 2.6px),
        radial-gradient(circle at calc(100% - 6px) 50%, #514b3e 0 1.6px, #6f6958 2px, transparent 2.6px),
        linear-gradient(180deg, #c0baa5, #b1ab96 50%, #a39d89);
      box-shadow: 0 0 0 1.5px var(--jk48-edge), 0 3px 5px rgba(20, 8, 0, 0.35), inset 0 -2px 0 rgba(40, 24, 8, 0.22);
      color: #110701;
    }
    #player.jk48 .jk48-coin-slot {
      flex: 0 0 auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      font-family: var(--jk48-sign);
      font-size: 10.5px;
      line-height: 1;
    }
    #player.jk48 .jk48-coin-slot i {
      display: block;
      width: 22px;
      height: 6px;
      border-radius: 3px;
      background: #0d0705;
      box-shadow: 0 0 0 2px #77715f, 0 0 0 3px rgba(36, 20, 11, 0.8), inset 0 1px 2px #000;
    }
    #player.jk48 .jk48-coin-words {
      flex: 1 1 auto;
      min-width: 0;
      text-align: center;
      font-family: var(--jk48-sign);
      font-size: 9.5px;
      line-height: 12px;
      letter-spacing: 0.08em;
      white-space: nowrap;
      overflow: hidden;
    }
    #player.jk48 .jk48-coin-words b {
      display: block;
      font-weight: normal;
    }
    #player.jk48 .jk48-coin-words em {
      display: none;
      font-style: normal;
    }

    /* paused jukeboxes glow a little dimmer */
    #player.jk48 .jk48-shade {
      position: absolute;
      inset: 0;
      z-index: 1;
      background: rgba(40, 12, 0, 0.36);
      opacity: 0;
      transition: opacity 0.6s ease;
      pointer-events: none;
    }
    #player.jk48:not(.is-playing) .jk48-shade {
      opacity: 1;
    }

    /* a little narrower: smaller keys */
    @container (max-width: 950px) {
      #player.jk48 .jk48-key { width: 52px; }
      #player.jk48 .jk48-key-play { width: 56px; }
      #player.jk48 .jk48-key .jk48-caption { font-size: 9.5px; letter-spacing: 0.03em; }
      #player.jk48 .jk48-keys { gap: 4px; }
      #player.jk48 .jk48-controls { gap: 6px; padding: 6px 8px 6px 9px; }
      #player.jk48 .jk48-wing-info { padding-left: 8px; }
      #player.jk48 .jk48-wing-info .jk48-panel { padding: 10px 16px 9px 8px; }
      #player.jk48 .jk48-wing-program { padding-right: 8px; }
      #player.jk48 .jk48-wing-program .jk48-panel { padding: 8px 8px 9px 16px; }
      #player.jk48 .jk48-coin { gap: 7px; padding: 3px 10px; }
      #player.jk48 .jk48-coin-words { letter-spacing: 0.06em; }
    }

    /* medium pages: the crown and the now-playing wing side by side, the program underneath */
    @container (max-width: 879px) {
      #player.jk48 .jk48-cabinet {
        display: grid;
        grid-template-columns: 304px minmax(0, 1fr);
        grid-template-areas: "crown info" "program program";
        align-items: end;
      }
      #player.jk48 .jk48-crown { grid-area: crown; }
      #player.jk48 .jk48-wing-info {
        grid-area: info;
        height: auto;
        min-height: 276px;
        margin: 0 0 0 -10px;
        padding: 10px 10px 0 0;
        border-radius: 8px 48px 8px 8px;
        background:
          repeating-conic-gradient(from 0deg at 0 100%, rgba(110, 36, 6, 0.28) 0deg 2deg, transparent 2deg 8deg) 100% 0 / 48px 48px no-repeat,
          repeating-linear-gradient(90deg, rgba(110, 36, 6, 0.28) 0 1.6px, transparent 1.6px 7.4px) 0 0 / calc(100% - 48px) 10px no-repeat,
          repeating-linear-gradient(180deg, rgba(110, 36, 6, 0.28) 0 1.6px, transparent 1.6px 7.4px) 100% 48px / 10px 100% no-repeat,
          radial-gradient(ellipse 30px 120px at 100% 70%, rgba(255, 236, 168, 0.75), transparent),
        radial-gradient(ellipse 120px 26px at 70% 0, rgba(255, 236, 168, 0.6), transparent),
          linear-gradient(180deg, #f2c35e, #e58d3a 45%, #c24e2c);
      }
      #player.jk48 .jk48-wing-info .jk48-panel {
        padding: 10px 10px 9px 20px;
        border-radius: 6px 38px 6px 6px;
      }
      #player.jk48 .jk48-wing-info .jk48-marquee { border-radius: 6px 28px 6px 6px; }
      #player.jk48 .jk48-wing-info .jk48-marquee-glass { border-radius: 4px 25px 4px 4px; padding: 0 10px 0 0; }
      #player.jk48 .jk48-wing-program {
        grid-area: program;
        height: auto;
        margin: -2px 0 0;
        padding: 0 10px 10px;
        border-radius: 6px 6px 16px 16px;
        background:
          repeating-linear-gradient(180deg, rgba(110, 36, 6, 0.28) 0 1.6px, transparent 1.6px 7.4px) 0 0 / 10px 100% no-repeat,
          repeating-linear-gradient(180deg, rgba(110, 36, 6, 0.28) 0 1.6px, transparent 1.6px 7.4px) 100% 0 / 10px 100% no-repeat,
          repeating-linear-gradient(90deg, rgba(110, 36, 6, 0.28) 0 1.6px, transparent 1.6px 7.4px) 0 100% / 100% 10px no-repeat,
          linear-gradient(180deg, #e58d3a, #c24e2c);
      }
      #player.jk48 .jk48-wing-program .jk48-panel {
        padding: 10px 12px;
        border-radius: 4px 4px 8px 8px;
      }
      #player.jk48 .jk48-program-head { margin: 0; }
      #player.jk48 .jk48-program-list {
        height: auto;
        max-height: 124px;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        background: linear-gradient(180deg, #2a170c, #3a2112);
      }
      /* the wing is wide again here, so the keys get their full size back */
      #player.jk48 .jk48-key { width: 64px; }
      #player.jk48 .jk48-key-play { width: 68px; }
      #player.jk48 .jk48-key .jk48-caption { font-size: 10.5px; letter-spacing: 0.06em; }
      #player.jk48 .jk48-keys { gap: 7px; }
      #player.jk48 .jk48-controls { gap: 8px; padding: 6px 10px 6px 12px; }
      #player.jk48 .jk48-film { --jk48-vh: 330px; }
      #player.jk48 .jk48-crown .jk48-film { --jk48-vx: 50cqw; --jk48-vy: 262px; }
      #player.jk48 .jk48-wing-info .jk48-film { --jk48-vx: calc(50cqw - 294px); --jk48-vy: 220px; }
      #player.jk48 .jk48-wing-program .jk48-film { --jk48-vx: 50cqw; --jk48-vy: -54px; }
      #player.jk48 .jk48-coin { justify-content: center; gap: 12px; }
      #player.jk48 .jk48-coin-words { flex: 0 1 auto; }
      #player.jk48 .jk48-coin-words b { display: inline; }
      #player.jk48 .jk48-coin-words em { display: inline; }
    }
    /* small pages: everything stacks under the crown, and the keys wrap under the knob when they must */
    @container (max-width: 679px) {
      #player.jk48 .jk48-controls {
        flex-wrap: wrap;
        justify-content: center;
        row-gap: 10px;
      }
      #player.jk48 .jk48-cabinet {
        grid-template-columns: minmax(0, 1fr);
        grid-template-areas: "crown" "info" "program";
      }
      #player.jk48 .jk48-crown {
        justify-self: center;
        margin-bottom: -16px;
      }
      #player.jk48 .jk48-wing-info {
        height: auto;
        min-height: 0;
        margin: 0;
        padding: 10px 10px 0;
        border-radius: 34px 34px 6px 6px;
        background:
          repeating-linear-gradient(90deg, rgba(110, 36, 6, 0.28) 0 1.6px, transparent 1.6px 7.4px) 0 0 / 100% 10px no-repeat,
          repeating-linear-gradient(180deg, rgba(110, 36, 6, 0.28) 0 1.6px, transparent 1.6px 7.4px) 0 0 / 10px 100% no-repeat,
          repeating-linear-gradient(180deg, rgba(110, 36, 6, 0.28) 0 1.6px, transparent 1.6px 7.4px) 100% 0 / 10px 100% no-repeat,
          linear-gradient(180deg, #f2c35e, #e58d3a 45%, #c24e2c);
      }
      #player.jk48 .jk48-wing-info .jk48-panel {
        padding: 22px 10px 10px;
        border-radius: 24px 24px 4px 4px;
      }
      #player.jk48 .jk48-wing-info .jk48-marquee { border-radius: 6px; }
      #player.jk48 .jk48-wing-info .jk48-marquee-glass { border-radius: 4px; padding: 0; }
      #player.jk48 .jk48-wing-program { margin-top: -2px; }
      #player.jk48 .jk48-film { --jk48-vw: 64cqw; --jk48-vh: 560px; }
      #player.jk48 .jk48-crown .jk48-film { --jk48-vx: 152px; --jk48-vy: 432px; }
      #player.jk48 .jk48-wing-info .jk48-film { --jk48-vx: 50cqw; --jk48-vy: 130px; }
      #player.jk48 .jk48-wing-program .jk48-film { --jk48-vx: 50cqw; --jk48-vy: -152px; }
      #player.jk48 .jk48-program-list {
        grid-template-columns: minmax(0, 1fr);
        max-height: 186px;
      }
    }
    /* the coin plate's words go under the slots */
    @container (max-width: 460px) {
      #player.jk48 .jk48-coin { flex-wrap: wrap; height: auto; padding: 5px 10px; row-gap: 4px; }
      #player.jk48 .jk48-coin-words { flex: 1 1 100%; }
    }
    @container (max-width: 380px) {
      #player.jk48 .jk48-wing-info .jk48-panel { padding: 22px 8px 9px; }
      #player.jk48 .jk48-wing-program .jk48-panel { padding: 10px 8px; }
      #player.jk48 .jk48-strip-foot { padding: 2px 5px 0; gap: 6px; }
      #player.jk48 .jk48-key { width: 56px; }
      #player.jk48 .jk48-key-play { width: 60px; }
    }
    @container (max-width: 330px) {
      #player.jk48 .jk48-crown { zoom: 0.9; }
      #player.jk48 .jk48-wing-info, #player.jk48 .jk48-wing-program { padding-left: 6px; padding-right: 6px; }
      #player.jk48 #title { font-size: 16px; line-height: 19px; }
    }

    /* Windows high contrast: drop the photograph look and every texture, keep the dial, knob and
       current pick visible, and leave the record window drawn as a picture so the record still shows */
    @media (forced-colors: active) {
      #player.jk48 {
        filter: none;
      }
      #player.jk48 :not(.jk48-dome-inner, .jk48-dome-inner *),
      #player.jk48 :not(.jk48-dome-inner, .jk48-dome-inner *)::before,
      #player.jk48 :not(.jk48-dome-inner, .jk48-dome-inner *)::after {
        background-image: none !important;
      }
      #player.jk48 .jk48-dome-inner {
        forced-color-adjust: none;
      }
      #player.jk48 .jk48-key .jk48-caption {
        -webkit-mask: none;
        mask: none;
      }
      #player.jk48 .jk48-film,
      #player.jk48 .jk48-glass,
      #player.jk48 .jk48-shade,
      #player.jk48 .jk48-bubbles {
        display: none;
      }
      #player.jk48 .jk48-dial,
      #player.jk48 .jk48-knob,
      #player.jk48 .jk48-small,
      #player.jk48 .jk48-key,
      #player.jk48 .jk48-time {
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
      #player.jk48 .jk48-dome {
        border: 2px solid CanvasText;
      }
      #player.jk48 :focus-visible {
        outline: 3px solid Highlight;
      }
      #player.jk48 .jk48-controls :focus-visible::after {
        display: none;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      #player.jk48 .jk48-crown::before,
      #player.jk48 .jk48-wing::before,
      #player.jk48 .jk48-record,
      #player.jk48.is-swapping .jk48-slot {
        animation: none;
      }
      /* the bubbles hold still where they are */
      #player.jk48 .jk48-bubbles i {
        animation-play-state: paused;
      }
      #player.jk48 .jk48-arm,
      #player.jk48 .jk48-shade,
      #player.jk48 .jk48-marquee-glass::after,
      #player.jk48 .jk48-key-play::before {
        transition: none;
      }
    }

    @keyframes jk48-spin {
      to { transform: rotate(360deg); }
    }
    @keyframes jk48-cycle {
      0%, 20% { opacity: 0; }
      80%, 100% { opacity: 0.85; }
    }
    /* up the side of the tube, then round the arch to the keystone */
    @keyframes jk48-bubble {
      0% { transform: rotate(-90deg) translateY(-134px) translateX(-170px); opacity: 0; }
      5% { opacity: 1; }
      47% { transform: rotate(-90deg) translateY(-134px) translateX(0); }
      94% { opacity: 1; }
      100% { transform: rotate(-7deg) translateY(-134px) translateX(0); opacity: 0; }
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
        <div class="jk48-wing jk48-wing-info">
          <span class="jk48-shade" aria-hidden="true"></span>
          <div class="jk48-panel jk48-center">
            <div class="jk48-marquee">
              <div class="jk48-marquee-glass">
                <span class="jk48-swash" aria-hidden="true"></span>
                <span id="jk48-status" role="status">PAUSED</span>
                <span class="jk48-swash jk48-swash-r" aria-hidden="true"></span>
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
                  <div class="jk48-dial-nums" aria-hidden="true"><i>2</i><i>4</i><i>6</i><i>8</i></div>
                  <div class="jk48-needle"></div>
                </div>
              </div>
              <span class="jk48-time" id="jk48-duration">-:--</span>
            </div>
            <div class="jk48-controls" id="controls">
              <div class="jk48-volume">
                <div class="jk48-volume-stack">
                  <span class="jk48-knob-scale" aria-hidden="true"></span>
                  <div class="jk48-knob" id="jk48-knob" role="slider" tabindex="0" aria-label="Volume" aria-valuemin="0" aria-valuemax="20" aria-valuenow="${currentVolume}">
                    <div class="jk48-knob-pointer"></div>
                  </div>
                  <span class="jk48-caption">VOLUME</span>
                </div>
                <div class="jk48-volume-steps">
                  <button type="button" class="jk48-small" id="volumeUpButton" aria-label="Volume up" title="Louder">+</button>
                  <button type="button" class="jk48-small" id="volumeDownButton" aria-label="Volume down" title="Softer">&minus;</button>
                </div>
              </div>
              <div class="jk48-keys">
                <button type="button" class="jk48-key" id="prevButton" aria-label="Back (previous record)" title="Previous record"><span class="jk48-caption">BACK</span></button>
                <button type="button" class="jk48-key jk48-key-play" id="playPauseButton" aria-label="Play" title="Play"><span class="jk48-caption">PLAY</span></button>
                <button type="button" class="jk48-key" id="nextButton" aria-label="Reject (next record)" title="Reject: skip to the next record"><span class="jk48-caption">REJECT</span></button>
              </div>
            </div>
          </div>
          <span class="jk48-film" aria-hidden="true"></span>
        </div>

        <div class="jk48-crown" aria-hidden="true">
          <span class="jk48-shade"></span>
          <span class="jk48-tube"></span>
          ${bubbles()}
          <span class="jk48-tube-wall"></span>
          <span class="jk48-keystone">&#9733;</span>
          <div class="jk48-dome">
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
              <div class="jk48-spindle"></div>
              <div class="jk48-arm">
                <div class="jk48-arm-rod"></div>
                <div class="jk48-arm-head"></div>
                <div class="jk48-arm-base"></div>
              </div>
              <div class="jk48-glass"></div>
            </div>
          </div>
          <div class="jk48-nameplate"><span>Automatic Phonograph</span></div>
          <span class="jk48-film"></span>
        </div>

        <div class="jk48-wing jk48-wing-program">
          <span class="jk48-shade" aria-hidden="true"></span>
          <div class="jk48-panel jk48-program">
            <div class="jk48-program-head" id="jk48-program-head">Selections</div>
            <ol class="jk48-program-list" id="jk48-program" aria-labelledby="jk48-program-head"></ol>
            <div class="jk48-coin" aria-hidden="true">
              <span class="jk48-coin-slot">5&cent;<i></i></span>
              <span class="jk48-coin-slot">10&cent;<i></i></span>
              <span class="jk48-coin-slot">25&cent;<i></i></span>
              <span class="jk48-coin-words"><b>INSERT COIN</b><em> &middot; </em><b>PUSH SELECTION</b></span>
            </div>
          </div>
          <span class="jk48-film" aria-hidden="true"></span>
        </div>
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
