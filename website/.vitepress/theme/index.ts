import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import CodeResult from "./components/CodeResult.vue";
import NextSteps from "./components/NextSteps.vue";
import StatusBadge from "./components/StatusBadge.vue";
import StepFlow from "./components/StepFlow.vue";
import "./custom.css";
import Layout from "./SiteLayout.vue";

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component("CodeResult", CodeResult);
    app.component("NextSteps", NextSteps);
    app.component("StatusBadge", StatusBadge);
    app.component("StepFlow", StepFlow);
  },
} satisfies Theme;
