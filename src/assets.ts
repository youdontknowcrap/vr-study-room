/**
 * Asset manifest (read by BOTH the app and the IWSDK editor).
 *
 * Only assets that the authored scene JSON places need to be listed here.
 * Our book PDF is loaded by pdf.js at runtime, so it is NOT in this list.
 *
 * Tip: always build URLs from import.meta.env.BASE_URL so the app works when
 * hosted under a sub-path (e.g. https://user.github.io/vr-study-room/).
 */
import { AssetType, defineAssets } from '@iwsdk/core';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

export default defineAssets({
  'welcome-panel': {
    url: publicAssetUrl('ui/welcome.uikitml'),
    type: AssetType.UIKitML,
    name: 'Welcome Panel',
  },
});
