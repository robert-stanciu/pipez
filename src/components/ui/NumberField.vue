<script setup lang="ts">
/**
 * A numeric field that commits on blur or Enter rather than on every keystroke.
 *
 * Committing per keystroke would re-solve the whole network while someone is halfway
 * through typing "3400", and briefly resize the room to 3 mm on the way.
 */
import { ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: number
    label?: string
    suffix?: string
    min?: number
    max?: number
    step?: number
    disabled?: boolean
  }>(),
  { step: 1, suffix: 'mm' },
)

const emit = defineEmits<{ 'update:modelValue': [value: number] }>()

const draft = ref(String(props.modelValue))
watch(
  () => props.modelValue,
  (value) => {
    draft.value = String(Math.round(value * 100) / 100)
  },
  { immediate: true },
)

function commit(): void {
  const parsed = Number.parseFloat(draft.value.replace(',', '.'))
  if (!Number.isFinite(parsed)) {
    draft.value = String(props.modelValue)
    return
  }
  const clamped = Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, parsed))
  draft.value = String(clamped)
  if (clamped !== props.modelValue) emit('update:modelValue', clamped)
}
</script>

<template>
  <label class="flex items-center justify-between gap-2 py-1">
    <span v-if="label" class="text-ink-400">{{ label }}</span>
    <span class="relative flex items-center">
      <input
        v-model="draft"
        type="number"
        :step="step"
        :min="min"
        :max="max"
        :disabled="disabled"
        class="numeric w-24 rounded border border-ink-700 bg-ink-900 py-1 pr-9 pl-2 text-right text-ink-100 outline-none focus:border-accent disabled:opacity-40"
        @blur="commit"
        @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
      />
      <span class="pointer-events-none absolute right-2 text-[11px] text-ink-400">{{ suffix }}</span>
    </span>
  </label>
</template>

<style scoped>
/* The spinners fight with the unit suffix and are useless at millimetre precision. */
input::-webkit-outer-spin-button,
input::-webkit-inner-spin-button {
  appearance: none;
  margin: 0;
}
input[type='number'] {
  appearance: textfield;
}
</style>
