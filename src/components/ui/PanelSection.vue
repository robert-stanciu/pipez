<script setup lang="ts">
/** Collapsible section with a title and an optional right-hand badge. */
import { ref } from 'vue'

withDefaults(defineProps<{ title: string; badge?: string | number; open?: boolean }>(), {
  open: true,
})

const expanded = ref(true)
</script>

<template>
  <section class="border-b border-ink-800">
    <button
      type="button"
      class="flex w-full items-center justify-between px-3 py-2 text-left text-[11px] font-semibold tracking-wide text-ink-300 uppercase hover:bg-ink-850"
      @click="expanded = !expanded"
    >
      <span class="flex items-center gap-2">
        <span
          class="text-ink-600 transition-transform"
          :class="expanded ? 'rotate-90' : ''"
          aria-hidden="true"
          >▸</span
        >
        {{ title }}
      </span>
      <span v-if="badge !== undefined" class="numeric rounded bg-ink-800 px-1.5 py-0.5 text-ink-300">
        {{ badge }}
      </span>
    </button>
    <div v-show="expanded" class="px-3 pb-3">
      <slot />
    </div>
  </section>
</template>
