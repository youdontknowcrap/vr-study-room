/**
 * Music & ambience with SPATIAL audio.
 *
 * How it works:
 * - An AudioListener rides on the camera (your head). It is the "ears".
 * - A PositionalAudio is attached to the little radio on the desk. It is
 *   the "speaker". Web Audio's PannerNode (HRTF model) makes the sound come
 *   FROM the radio: turn your head and it moves between your ears.
 * - Tracks play through a plain <audio> element piped into Web Audio
 *   (setMediaElementSource). That streams long MP3s instead of decoding the
 *   whole song into memory - important on Quest.
 *
 * Your own MP3s: picked with a file input and played from `blob:` object
 * URLs. They never leave the device and are forgotten when you close the tab.
 *
 * Browsers block sound until the user interacts with the page ("autoplay
 * policy"). `unlock()` is called on the first click / key press / Enter VR.
 */
import {
  AudioListener,
  PositionalAudio,
  signal,
  type Object3D,
} from '@iwsdk/core';

export interface Track {
  name: string;
  url: string;
  loop: boolean;
  /** true for user files (object URLs we must revoke later) */
  userFile: boolean;
}

const base = import.meta.env.BASE_URL;
const BUNDLED: Track[] = [
  { name: 'Fireplace crackle', url: `${base}audio/fireplace-loop.mp3`, loop: true, userFile: false },
  { name: 'Rain', url: `${base}audio/rain-loop.mp3`, loop: true, userFile: false },
];

export class Music {
  readonly listener = new AudioListener();
  readonly speaker: PositionalAudio;
  readonly tracks = signal<Track[]>([...BUNDLED]);
  readonly index = signal(0);
  readonly playing = signal(false);
  readonly volume = signal(0.6);

  private readonly el = new Audio();
  private unlocked = false;
  // Fireplace / rain stay quiet until Play in the menu. Entering VR only
  // unlocks the audio device; it does not start the loop.
  private wantPlay = false;

  constructor(camera: Object3D, speakerParent: Object3D) {
    camera.add(this.listener);
    this.speaker = new PositionalAudio(this.listener);
    // Distances in meters: full volume within 0.6 m, gentle fall-off beyond.
    this.speaker.setRefDistance(0.6);
    this.speaker.setRolloffFactor(1.2);
    this.speaker.panner.panningModel = 'HRTF';
    speakerParent.add(this.speaker);

    this.el.crossOrigin = 'anonymous';
    this.el.preload = 'auto';
    this.speaker.setMediaElementSource(this.el);
    this.el.addEventListener('ended', () => this.next());
    this.el.addEventListener('play', () => (this.playing.value = true));
    this.el.addEventListener('pause', () => (this.playing.value = false));
    this.volume.subscribe((v) => this.speaker.setVolume(v));
    this.load(0);
  }

  /** Call from a user gesture (click, key, Enter VR) to allow sound. */
  unlock(): void {
    if (this.unlocked) return;
    void this.listener.context.resume().then(() => {
      this.unlocked = true;
      if (this.wantPlay) this.play();
    });
  }

  play(): void {
    this.wantPlay = true;
    if (!this.unlocked) return;
    this.el.play().catch((e) => console.warn('[music] play blocked', e));
  }
  pause(): void {
    this.wantPlay = false;
    this.el.pause();
  }
  togglePlay(): void {
    if (this.playing.value) this.pause();
    else this.play();
  }
  next(): void {
    const n = this.tracks.value.length;
    this.load((this.index.value + 1) % n);
    if (this.wantPlay) this.play();
  }
  changeVolume(step: number): void {
    this.volume.value = Math.round(Math.min(1, Math.max(0, this.volume.value + step)) * 10) / 10;
  }

  /** Add user-picked audio files (kept in memory for this session only). */
  addFiles(files: FileList | File[]): void {
    const added: Track[] = Array.from(files)
      .filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|ogg|wav)$/i.test(f.name))
      .map((f) => ({
        name: f.name.replace(/\.[^.]+$/, ''),
        url: URL.createObjectURL(f),
        loop: false,
        userFile: true,
      }));
    if (added.length === 0) return;
    const first = this.tracks.value.length;
    this.tracks.value = [...this.tracks.value, ...added];
    this.load(first); // jump to the first new song
    this.play();
  }

  get currentName(): string {
    return this.tracks.value[this.index.value]?.name ?? '';
  }

  private load(i: number): void {
    const t = this.tracks.value[i];
    if (!t) return;
    this.index.value = i;
    this.el.loop = t.loop;
    this.el.src = t.url;
  }
}
