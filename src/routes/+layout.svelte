<script>
  import '../app.css';
  import { onMount } from 'svelte';
  import { loadSettings } from '$lib/settings.js';

  onMount(() => {
    const refresh = () => { void loadSettings().catch(error => console.error('Failed to load window filters:', error)); };
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  });

  let { children } = $props();
</script>

{@render children()}
