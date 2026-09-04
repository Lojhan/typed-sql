import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { defineAsyncComponent } from "vue";
import CodeResult from "./components/CodeResult.vue";
import DialectCards from "./components/DialectCards.vue";
import HomeHero from "./components/HomeHero.vue";
import NextSteps from "./components/NextSteps.vue";
import PathCards from "./components/PathCards.vue";
import ProductStatus from "./components/ProductStatus.vue";
import StatusBadge from "./components/StatusBadge.vue";
import StepFlow from "./components/StepFlow.vue";
import "./custom.css";
import Layout from "./SiteLayout.vue";

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component("CodeResult", CodeResult);
    app.component("DialectCards", DialectCards);
    app.component("HomeHero", HomeHero);
    app.component("NextSteps", NextSteps);
    app.component("PathCards", PathCards);
    app.component("ProductStatus", ProductStatus);
    app.component(
      "QueryTypeDemo",
      defineAsyncComponent(() => import("./components/QueryTypeDemo.vue")),
    );
    app.component(
      "SqlPlayground",
      defineAsyncComponent(() => import("./components/SqlPlayground.vue")),
    );
    app.component("StatusBadge", StatusBadge);
    app.component("StepFlow", StepFlow);
  },
} satisfies Theme;
