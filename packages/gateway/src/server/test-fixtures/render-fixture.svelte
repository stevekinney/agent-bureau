<script lang="ts">
  let { initialData, pathname }: { initialData: { label: string }; pathname: string } =
    $props();
</script>

<main data-pathname={pathname}>
  <h1>Fixture</h1>
  <p class="fixture-label">{initialData.label}</p>
</main>
