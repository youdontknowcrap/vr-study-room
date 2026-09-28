/**
 * VR Study Room — entry point.
 *
 * Startup order:
 *  1. World.create() builds the renderer, scene, camera, XR plumbing and
 *     loads the authored scene (public/scenes/main.iwsdk.scene.json), which
 *     here only contains the welcome panel with the "Enter VR" button.
 *  2. We build our own objects in code: room/desk, environment photo, book,
 *     music, and the 2D launch overlay.
 *  3. We register our systems. Lower `priority` runs first each frame:
 *     input (reads devices) -> menu (may "consume" a press) -> book.
 */
import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { app, loadSampleBook } from './app.js';
import { Music } from './audio/music.js';
import { Book } from './book/book.js';
import { BookSystem } from './book/book-system.js';
import { InputLayerSystem } from './input/input-layer-system.js';
import { MenuSystem } from './menu/menu-system.js';
import { PanelSystem } from './panel.js';
import { EnvironmentManager } from './room/environments.js';
import { Room } from './room/room.js';
import { environmentId } from './settings.js';
import { LaunchOverlay } from './ui2d/launch-overlay.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  app.world = world;

  // --- Room + environment photo -------------------------------------
  app.room = new Room();
  world.scene.add(app.room.area);
  app.environments = new EnvironmentManager(world.scene);
  environmentId.subscribe((id) => void app.environments.show(id));

  // --- Music (speaker lives in the desk radio) -----------------------
  app.music = new Music(world.camera, app.room.radio);
  // Browsers only allow audio after a user gesture: unlock on the first one.
  const unlock = () => app.music.unlock();
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  // --- 2D page overlay (file pickers live here) ----------------------
  app.overlay = new LaunchOverlay((files) => app.music.addFiles(files));

  // --- Book ------------------------------------------------------------
  app.book = new Book();
  void loadSampleBook();

  // --- Systems ---------------------------------------------------------
  world.registerSystem(InputLayerSystem, { priority: 1 });
  world.registerSystem(MenuSystem, { priority: 2 });
  world.registerSystem(BookSystem, { priority: 3 });
  world.registerSystem(PanelSystem); // welcome panel's Enter VR / Exit buttons

  // Entering VR counts as a gesture too; also unlock audio then.
  world.visibilityState.subscribe(() => app.music.unlock());

  // Handy for debugging in the browser console: window.app
  (window as unknown as { app: typeof app }).app = app;
});
