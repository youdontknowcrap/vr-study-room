/**
 * VR Study Room — entry point.
 *
 * Startup order:
 *  1. World.create() builds the renderer, scene, camera, XR plumbing and
 *     loads the authored scene (public/scenes/main.iwsdk.scene.json), which
 *     here only contains the welcome panel with the "Enter VR" button.
 *  2. We build our own objects in code: the room (walls, glass door, desk),
 *     the book, music, and the 2D launch overlay.
 *  3. We register our systems. Lower `priority` runs first each frame:
 *     input (reads devices) -> menu (may "consume" a press) -> book.
 */
import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { app, loadSampleBook } from './app.js';
import { Music } from './audio/music.js';
import { Book } from './book/book.js';
import { BookSystem } from './book/book-system.js';
import { saveProgress } from './book/reading-progress.js';
import { InputLayerSystem } from './input/input-layer-system.js';
import { MenuSystem } from './menu/menu-system.js';
import { PanelSystem } from './panel.js';
import { createRoom } from './room/create-room.js';
import { onRoomChange, switchRoom } from './room/room-switch.js';
import { bookScale, deskHeight, deskTilt, roomChoice, roomQuality } from './settings.js';
import { LaunchOverlay } from './ui2d/launch-overlay.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then(async (world) => {
  app.world = world;

  // --- Room --------------------------------------------------------------
  // the sitcom apartment (a 3D model) by default, or the built-in glass-door
  // room with the pool view (menu: "Room"). Both provide the same "desk".
  app.room = await createRoom(roomChoice.value, roomQuality.value);
  world.scene.add(app.room.area);
  // Desk height/tilt come from saved settings; re-apply when they change.
  const applyDesk = () => app.room.setDesk(deskHeight.value, deskTilt.value);
  applyDesk();
  deskHeight.subscribe(applyDesk);
  deskTilt.subscribe(applyDesk);
  // Menu "Room" button changes roomChoice -> build and swap in that room.
  // Same for "Quality: High / Lite" (reloads the model room in that build).
  // (subscribe() also fires once right away; `shown` skips that first call.)
  // `shown` = what's on screen; quality only matters for model rooms.
  const wanted = () => (roomChoice.value === 'glass' ? 'glass' : `${roomChoice.value}/${roomQuality.value}`);
  let shown = wanted();
  let busy = false;
  const onRoomSetting = async () => {
    const want = wanted();
    if (busy || want === shown) return;
    busy = true;
    try {
      await switchRoom(roomChoice.value);
    } finally {
      shown = want;
      busy = false;
    }
    void onRoomSetting(); // clicked again while loading? catch up now
  };
  roomChoice.subscribe(() => void onRoomSetting());
  roomQuality.subscribe(() => void onRoomSetting());

  // --- Music (speaker lives in the desk radio) -----------------------
  app.music = new Music(world.camera, app.room.radio);
  // New room (menu "Room"): the speaker moves into the new radio.
  onRoomChange((room) => room.radio.add(app.music.speaker));
  // Browsers only allow audio after a user gesture: unlock on the first one.
  const unlock = () => app.music.unlock();
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  // --- 2D page overlay (file pickers live here) ----------------------
  app.overlay = new LaunchOverlay((files) => app.music.addFiles(files));

  // --- Book ------------------------------------------------------------
  app.book = new Book();
  // Remember the page you're on, per book (localStorage).
  app.book.onSpreadChange = (left) => saveProgress(app.book.bookId, left);
  void loadSampleBook();

  // --- Systems ---------------------------------------------------------
  world.registerSystem(InputLayerSystem, { priority: 1 });
  world.registerSystem(MenuSystem, { priority: 2 });
  world.registerSystem(BookSystem, { priority: 3 });
  world.registerSystem(PanelSystem); // welcome panel's Enter VR / Exit buttons

  // Entering VR counts as a gesture too; also unlock audio then.
  world.visibilityState.subscribe(() => app.music.unlock());

  // Handy for debugging in the browser console (and used by the smoke
  // test): window.app, window.settings.bookScale.value = 1.5, ...
  Object.assign(window, { app, settings: { bookScale, deskHeight, deskTilt, roomChoice, roomQuality } });
});
