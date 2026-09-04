<script lang="ts">
import { useData } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { computed, defineComponent, h } from "vue";

export default defineComponent({
  name: "SiteLayout",
  setup() {
    const { frontmatter } = useData();
    const pageTypeClass = computed(() => `typed-sql-page--${frontmatter.value.pageType ?? "unclassified"}`);
    return () => h(DefaultTheme.Layout, { class: pageTypeClass.value });
  },
});
</script>
