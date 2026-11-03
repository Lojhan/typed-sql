<script setup lang="ts">
import { onMounted, ref } from "vue";
export interface TreeNameEdit {
  target?: string;
  name: string;
  folder: boolean;
  label: string;
  error: string;
  change: (name: string) => void;
  submit: () => void;
  cancel: () => void;
}
const props = defineProps<{ edit: TreeNameEdit }>();
const input = ref<HTMLInputElement>();
onMounted(() => {
  input.value?.focus();
  const end =
    !props.edit.folder && props.edit.name.includes(".") ? props.edit.name.lastIndexOf(".") : props.edit.name.length;
  input.value?.setSelectionRange(0, end);
});
</script>

<template>
  <span class="pg-file-name-editor" @click.stop @pointerdown.stop @contextmenu.stop @keydown.stop>
    <input ref="input" class="pg-file-name-input" :value="edit.name" :aria-label="edit.label" :aria-invalid="Boolean(edit.error)" :aria-describedby="edit.error ? 'pg-entry-error' : undefined" spellcheck="false" autocomplete="off" @input="edit.change(($event.target as HTMLInputElement).value)" @keydown.enter.prevent="edit.submit" @keydown.esc.prevent="edit.cancel" @blur="edit.cancel" />
  </span>
</template>
