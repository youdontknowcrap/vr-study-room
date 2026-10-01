/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, UIKitMLAsset, VisibilityState } from '@iwsdk/core';
import { showExitBrowser } from './settings.js';

export class PanelSystem extends createSystem({}) {
  private panel?: UIKitMLAsset;
  private inXR = false;

  init(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('welcome-panel');
    const xrButton = panel?.getElementById('xr-button');
    const exitButton = panel?.getElementById('exit-button');
    if (panel == null || xrButton == null || exitButton == null) {
      return;
    }
    this.panel = panel;
    if (!this.world.xrEnabled) {
      xrButton.setProperties({ display: 'none' });
      exitButton.setProperties({ display: 'none' });
      return;
    }

    const launchXR = () => this.world.launchXR();
    const exitXR = () => this.world.exitXR();
    xrButton.addEventListener('click', launchXR);
    exitButton.addEventListener('click', exitXR);
    const apply = (): void => {
      const showExit = this.inXR && showExitBrowser.value;
      xrButton.setProperties({ display: this.inXR ? 'none' : 'flex' });
      exitButton.setProperties({ display: showExit ? 'flex' : 'none' });
      // In VR this card is the floating Exit to browser control.
      panel.visible = !this.inXR || showExitBrowser.value;
    };
    this.cleanupFuncs.push(
      () => xrButton.removeEventListener('click', launchXR),
      () => exitButton.removeEventListener('click', exitXR),
      this.world.visibilityState.subscribe((visibilityState) => {
        this.inXR = visibilityState !== VisibilityState.NonImmersive;
        apply();
      }),
      showExitBrowser.subscribe(() => apply()),
    );
  }
}
