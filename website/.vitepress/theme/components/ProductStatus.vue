<script lang="ts">
import { data as productStatus } from "../../data/product-status.data.js";

export default {
  name: "ProductStatus",
  data() {
    return { productStatus };
  },
};
</script>

<template>
  <div class="ts-product-status">
    <section>
      <StatusBadge status="stable" label="Stable packages" />
      <h3><slot name="stable-title" /></h3>
      <div class="ts-product-status__description"><slot name="stable-description" /></div>
      <ul aria-label="Stable typed-sql packages">
        <li v-for="packageName in productStatus.stable" :key="packageName">{{ packageName }}</li>
      </ul>
    </section>
    <section>
      <StatusBadge status="experimental" label="Experimental tooling" />
      <h3><slot name="experimental-title" /></h3>
      <div class="ts-product-status__description"><slot name="experimental-description" /></div>
      <ul aria-label="Experimental typed-sql packages">
        <li v-for="packageName in productStatus.experimental" :key="packageName">{{ packageName }}</li>
      </ul>
    </section>
  </div>
</template>
