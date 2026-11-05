<script setup lang="ts">
/**
 * An image that opens at full size when clicked, as Naive UI's NImage did.
 * Attributes such as `alt`, `referrerpolicy`, `@load` and `@error` go to the `<img>`, so the
 * preview loads the picture the same way.
 */
import { ref } from 'vue'
import { useText } from '../config'
import Modal from './Modal.vue'

defineOptions({ inheritAttrs: false })

withDefaults(defineProps<{
  src?: string
  /** Shows the picture only, without the larger view on click. */
  previewDisabled?: boolean
  objectFit?: 'contain' | 'cover' | 'fill' | 'none' | 'scale-down'
}>(), { previewDisabled: false })

const text = useText()
const open = ref(false)
</script>

<template>
  <img v-if="previewDisabled" v-bind="$attrs" :src="src" class="mu-image" :style="{ objectFit }">
  <button v-else type="button" class="mu-image-trigger" :aria-label="text.preview" @click="open = true">
    <img v-bind="$attrs" :src="src" class="mu-image mu-image--zoomable" :style="{ objectFit }">
  </button>
  <Modal v-if="!previewDisabled" v-model:show="open" bare :label="text.preview">
    <button type="button" class="mu-image-preview" :aria-label="text.close" @click="open = false">
      <img :src="src" :alt="($attrs.alt as string | undefined) ?? ''" :referrerpolicy="$attrs.referrerpolicy as ReferrerPolicy | undefined">
    </button>
  </Modal>
</template>

<style>
.mu-image { display: block; max-width: 100%; }
.mu-image--zoomable { cursor: zoom-in; }

.mu-image-trigger {
  display: block;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: none;
  cursor: zoom-in;
}

.mu-image-trigger:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--focus); }

.mu-image-preview {
  display: block;
  padding: 0;
  border: 0;
  background: none;
  cursor: zoom-out;
}

.mu-image-preview img {
  display: block;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 48px);
  border-radius: 6px;
  box-shadow: var(--shadow-pop);
}
</style>
