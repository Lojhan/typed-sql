<script lang="ts">
import { useData } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { computed, defineComponent, h } from "vue";

export default defineComponent({
  name: "SiteLayout",
  setup() {
    const { frontmatter, page } = useData();
    const pageClasses = computed(() => [
      `typed-sql-page--${frontmatter.value.pageType ?? "unclassified"}`,
      ...(page.value.relativePath === "index.md" ? ["typed-sql-page--home"] : []),
    ]);
    return () => h(DefaultTheme.Layout, { class: pageClasses.value });
  },
});
</script>
