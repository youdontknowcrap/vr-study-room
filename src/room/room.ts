/**
 * Room — the seated "study area": a desk in front of you, plus anchor points
 * for where the book and menu should sit. Everything is kept inside a ~0.6 m
 * reach so the experience works seated (competition asks for ~2 ft radius).
 *
 * RECENTER: people sit at different heights and face different directions.
 * `recenter(head)` moves the whole study area so the desk is in front of
 * you at a comfortable height. It runs automatically when you enter VR.
 */
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  type Quaternion,
  Vector3,
} from '@iwsdk/core';
import { yawOf } from './head-pose.js';

/** Desk top this far below your eyes (meters). Typical seated eye-to-desk. */
const DESK_BELOW_EYES = 0.5;
/** Desk front edge distance from your eyes, horizontally. */
const DESK_DISTANCE = 0.3;

export class Room {
  /** Move this to move the desk + anchors together. */
  readonly area = new Group();
  /** Where the book rests when it is "on the desk". */
  readonly bookAnchor = new Object3D();
  /** Where the small "Menu" tab button sits (left front corner of the desk). */
  readonly menuTabAnchor = new Object3D();
  /** Little tabletop radio (right back corner). Music plays FROM here. */
  readonly radio = new Group();

  private readonly tmp = new Vector3();

  constructor() {
    const wood = new MeshStandardMaterial({ color: 0x5a3b26, roughness: 0.7 });
    // Desk top: 1.0 m wide, 0.55 m deep, 3 cm thick. Area origin = desk top
    // front-center, so "forward" (-z) goes across the desk.
    const top = new Mesh(new BoxGeometry(1.0, 0.03, 0.55), wood);
    top.position.set(0, -0.015, -0.275);
    // One slab under it reads as a desk body without 4 extra leg meshes.
    const body = new Mesh(new BoxGeometry(0.9, 0.7, 0.04), wood);
    body.position.set(0, -0.38, -0.52);
    this.area.add(top, body);

    // Book floats ~15 cm above the desk, tilted toward you like a lectern.
    this.bookAnchor.position.set(0, 0.17, -0.2);
    this.bookAnchor.rotation.x = -0.75; // radians (~43 degrees)
    this.menuTabAnchor.position.set(-0.36, 0.03, -0.08);
    this.menuTabAnchor.rotation.x = -0.9;
    this.area.add(this.bookAnchor, this.menuTabAnchor);

    // Radio: a box + a cloth-colored front panel. 2 meshes, no textures.
    const radioBody = new Mesh(
      new BoxGeometry(0.16, 0.1, 0.07),
      new MeshStandardMaterial({ color: 0x3b2417, roughness: 0.5 }),
    );
    const grille = new Mesh(
      new BoxGeometry(0.1, 0.07, 0.004),
      new MeshStandardMaterial({ color: 0xc9b48a, roughness: 1 }),
    );
    grille.position.set(-0.02, 0, 0.036);
    this.radio.add(radioBody, grille);
    this.radio.position.set(0.36, 0.05, -0.38);
    this.radio.rotation.y = -0.5; // angled toward you
    this.area.add(this.radio);

    // Default placement for a seated person with eyes at ~1.2 m.
    this.placeFor(new Vector3(0, 1.2, 0), 0);
  }

  /** Move the desk in front of `head` (world position) facing `yaw` (radians). */
  placeFor(head: Vector3, yaw: number): void {
    const deskY = Math.max(0.45, head.y - DESK_BELOW_EYES);
    // "forward" for a yaw angle: three.js cameras look down -z.
    this.tmp.set(-Math.sin(yaw), 0, -Math.cos(yaw)).multiplyScalar(DESK_DISTANCE);
    this.area.position.set(head.x + this.tmp.x, deskY, head.z + this.tmp.z);
    this.area.rotation.set(0, yaw, 0);
    this.area.updateMatrixWorld(true);
  }

  /**
   * Recenter on a head pose (world position + rotation). Get the pose with
   * getHeadPose() from head-pose.ts, NOT from world.camera (see that file).
   */
  recenter(headPos: Vector3, headQuat: Quaternion): void {
    this.placeFor(headPos, yawOf(headQuat, this.tmp));
  }
}
