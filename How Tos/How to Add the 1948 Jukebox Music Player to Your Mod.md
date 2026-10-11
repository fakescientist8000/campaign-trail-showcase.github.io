# How to Add the 1948 Jukebox Music Player to Your Mod

The 1948 jukebox is a late-1940s take on the music player from the mod 1932. It sits under the game window and looks like the face of a jukebox from that era, worn in like an old photograph: a 78 r.p.m. record turning behind old glass under an arch of lit plastic and a bubble tube, typed title strips with numbered selector buttons, a coin plate, Bakelite keys and a volume knob.

It uses the same `Song`, `Playlist` and `changePlaylist` code as the 1932 player, so playlists you've already written for that player will work with this one. It plays normal audio links and YouTube links. Everything is drawn with CSS, so there are no images to host.

To see it before adding it, open [`static/music_players/jukebox_1948_preview.html`](../static/music_players/jukebox_1948_preview.html) on the site.

**Step 1.** Copy all of [`static/music_players/jukebox_1948.js`](../static/music_players/jukebox_1948.js) and paste it into your mod's Code 2. This works if you add the mod as a custom mod to the mod loader too, so you can test it while you work.

**Step 2.** Change the songs. Near the top of the code is a list called `JUKEBOX_SONGS`. Each line is one record:

```javascript
const JUKEBOX_SONGS = [
    // [title, artist, cover image link, audio link or YouTube link]
    ["Twelfth Street Rag", "Pee Wee Hunt", "", "https://audio.jukehost.co.uk/6Af2WZKp4sSedpGG3D6KtVDLctnDPaoG"],
    ["Nature Boy", "Nat King Cole", "", "https://www.youtube.com/watch?v=VIDEO_ID_HERE"]
];
```

- **Cover image link:** leave it as `""` and the player prints a 78 label with the title and artist on it. If you give it an image link, the image fills the label in the middle of the record. If the image fails to load, the player falls back to the printed label.
- **Audio or YouTube link:** a direct audio file link (like Jukehost) or any normal YouTube link (`youtube.com/watch?v=`, `youtu.be/`, `/embed/`, `/shorts/`).

**Step 3 (optional).** Change the music partway through the game. Anywhere in your code you can build a new playlist and hand it to the jukebox, exactly as with the 1932 player:

```javascript
const playlist = new Playlist();
playlist.addSong(new Song(
    "I'm Looking Over a Four Leaf Clover",
    "Art Mooney",
    "",
    "https://audio.jukehost.co.uk/gpY5mk2inQRxstI4L7PRpPPcg9zqy20W"
));
changePlaylist(playlist);
```

The new playlist starts from its first song, and the list of selections updates to match.

## Controls

- **BACK / PLAY / REJECT:** previous record, play or pause, and skip to the next record. ("Reject" is what the skip button was called on real jukeboxes.)
- **Selections:** click any record in the list to play it. Clicking the one that's already playing pauses or resumes it.
- **Volume:** the − and + buttons, or drag the knob up or down. Once you've clicked the knob (or tabbed to it), the mouse wheel and arrow keys turn it too. Scrolling past the knob never changes the volume. The volume is remembered between visits.
- **Dial:** click or drag the dial under the title strip to move through the song. Once it's focused, the arrow keys move 5 seconds and Page Up/Page Down move 30 seconds.

The hand-painted sign above the title strip reads Now playing, Paused, Warming up while a song loads, or Out of order if a song can't be played. Press PLAY to try that record again, or REJECT to move on.

## Notes

- Only add one music player to a mod. If another player is already on the page, the jukebox won't add itself.
- On narrow screens the selections move under the record and keys.
- If a player has reduced motion turned on in their system settings, the record and bubble tubes stand still.
- The two little counters either side of the dial show how far into the record you are and how long it is.
- Keys the jukebox uses (arrows on the knob and dial, Enter on its buttons) don't also trigger the game's keyboard shortcuts.
- For other code, `window.jukebox1948` has `play()`, `pause()`, `toggle()`, `next()`, `previous()`, `select(index)` (the first song is 0) and `setVolume(0-20)`.
