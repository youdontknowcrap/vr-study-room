/**
 * Components the IWSDK scene editor is allowed to author.
 *
 * The study room builds its objects in code (see src/room, src/book), so
 * there are no custom ECS components yet. Keep this file: iwsdk.config.json
 * points at it, and the editor imports it.
 */
import { defineComponents } from '@iwsdk/core';

export default defineComponents([]);
