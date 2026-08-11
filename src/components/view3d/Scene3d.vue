<script setup lang="ts">
/** The 3-D viewport: same stores as the plan, so the two views can never disagree. */
import { TresCanvas } from '@tresjs/core'

import { useViewStore } from '../../stores/view.ts'
import SceneContent from './SceneContent.vue'

const view = useViewStore()
</script>

<template>
  <div class="relative h-full w-full bg-ink-950">
    <TresCanvas clear-color="#0a0e14" :alpha="false" :window-size="false">
      <SceneContent />
    </TresCanvas>

    <div
      class="pointer-events-none absolute bottom-2 left-3 text-[11px] text-ink-400"
      :class="view.xray ? '' : 'opacity-60'"
    >
      drag to orbit · scroll to zoom · right-drag to pan
    </div>
  </div>
</template>
