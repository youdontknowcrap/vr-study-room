/**
 * LaunchOverlay — the small HTML card on the normal (2D) web page.
 *
 * This is where file pickers live, because browsers only open a file
 * dialog in response to a real click on the page. Hidden <input type=file>
 * elements do the actual picking; nothing is uploaded anywhere - files are
 * read locally in the browser.
 */
import { app, loadBookFile, loadSampleBook, type PickerKind } from '../app.js';

export class LaunchOverlay {
  private readonly root = document.createElement('div');
  private readonly status = document.createElement('div');
  private readonly prompt = document.createElement('div');
  private readonly bookInput = document.createElement('input');
  private readonly musicInput = document.createElement('input');

  /**
   * `onMusicFiles` only adds tracks to the music player. It must NEVER
   * reload or move the book (that was the suspected cause of the "book
   * vanishes after loading an MP3" bug; the real cause was the VR re-entry
   * recenter, see room/head-pose.ts).
   */
  constructor(private onMusicFiles: (files: FileList) => void) {
    this.bookInput.type = 'file';
    this.bookInput.accept = 'application/pdf,application/epub+zip,.pdf,.epub';
    this.musicInput.type = 'file';
    this.musicInput.accept = 'audio/*,.mp3';
    this.musicInput.multiple = true;
    for (const i of [this.bookInput, this.musicInput]) i.hidden = true;

    this.bookInput.addEventListener('change', async () => {
      const file = this.bookInput.files?.[0];
      this.bookInput.value = ''; // allow picking the same file again later
      if (!file) return;
      this.hidePrompt();
      await loadBookFile(file);
    });
    this.musicInput.addEventListener('change', () => {
      const files = this.musicInput.files;
      if (files && files.length) {
        this.onMusicFiles(files);
        this.setStatus(`Added ${files.length} track(s). They play from the desk radio.`);
      }
      this.musicInput.value = '';
      this.hidePrompt();
    });

    this.root.id = 'launch-overlay';
    this.root.innerHTML = `
      <style>
        #launch-overlay { position: fixed; left: 20px; bottom: 20px; z-index: 10;
          width: min(340px, calc(100vw - 40px)); padding: 16px; border-radius: 16px;
          background: rgba(28,22,18,.92); color: #f3e6cf; font: 15px/1.4 system-ui, sans-serif; }
        #launch-overlay h1 { font-size: 18px; margin: 0 0 8px; }
        #launch-overlay button { margin: 4px 4px 0 0; padding: 10px 12px; border: 0;
          border-radius: 10px; background: #4a3a2e; color: #f3e6cf; font: inherit; cursor: pointer; }
        #launch-overlay button:hover { background: #d9a55b; color: #1c1612; }
        #launch-overlay .prompt { display: none; margin-top: 10px; padding: 10px;
          border-radius: 10px; background: #d9a55b; color: #1c1612; }
        #launch-overlay .prompt button { background: #1c1612; color: #f3e6cf; }
        #launch-overlay .status { margin-top: 8px; color: #bfae94; font-size: 13px; }
      </style>
      <h1>VR Study Room</h1>
      <div>
        <button data-act="book">Open book…</button>
        <button data-act="sample">Sample book</button>
        <button data-act="music">Add music…</button>
        <button data-act="back">Bring book back</button>
      </div>`;
    this.prompt.className = 'prompt';
    this.status.className = 'status';
    this.root.append(this.prompt, this.status, this.bookInput, this.musicInput);
    document.body.append(this.root);

    this.root.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest('button')?.dataset.act;
      if (act === 'book') this.openPicker('book');
      if (act === 'music') this.openPicker('music');
      if (act === 'sample') void loadSampleBook();
      if (act === 'back') app.bookSystem?.bringBack();
    });
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  /** Must be called from inside a click handler (browser rule for file dialogs). */
  openPicker(kind: PickerKind): void {
    (kind === 'book' ? this.bookInput : this.musicInput).click();
  }

  /** Shown after leaving VR from the in-VR menu: one big button to tap. */
  promptPicker(kind: PickerKind): void {
    const what = kind === 'book' ? 'a PDF or EPUB' : 'music files';
    this.prompt.innerHTML = `Tap below to choose ${what}, then press <b>Enter VR</b> again.<br>`;
    const btn = document.createElement('button');
    btn.textContent = kind === 'book' ? 'Choose book…' : 'Choose music…';
    btn.addEventListener('click', () => this.openPicker(kind));
    this.prompt.append(btn);
    this.prompt.style.display = 'block';
  }

  private hidePrompt(): void {
    this.prompt.style.display = 'none';
  }
}
