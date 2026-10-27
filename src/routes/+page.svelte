<svelte:head>
  <title>Barktown</title>
  <meta name="description" content="Explore Barktown's diary, report, training data and research method." />
</svelte:head>

<main class="intro">
  <section class="intro-card">
    <p class="eyebrow"><img class="brand-logo" src="/logo.png" alt="" width="144" height="144" /> Barktown</p>
    <h1>Project «Barktown»</h1>
    <p class="lede">Bark disturbance diary</p>

    <nav aria-label="Barktown views">
      <a href="/report">
        <strong>See the report</strong>
        <span>Recent bark report, 1 week at a time</span>
      </a>
      <a href="/diary">
        <strong>Explore the full diary</strong>
        <span>The complete bark disturbance timeline starting from 2021</span>
      </a>
      <a href="/training">
        <strong>See training data</strong>
        <span>Audit how the model was trained to detect barks</span>
      </a>
      <a href="/method">
        <strong>About the project</strong>
        <span>Technology and science of bark detection</span>
      </a>
    </nav>
  </section>
</main>

<style>
  :global(*, *::before, *::after) { box-sizing: border-box; }
  :global(body) {
    margin: 0;
    font-family: var(--font-body);
    background: #f7f7f5;
    color: #1a1a1a;
  }

  .intro {
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: 2rem 1rem;
  }

  .intro-card {
    width: min(100%, 720px);
  }

  .eyebrow {
    margin: 0 0 0.75rem;
    font-weight: 700;
  }

  h1 {
    margin: 0;
    font-size: var(--font-size-xlarge);
  }

  .lede {
    margin: 0.65rem 0 1.6rem;
    color: #777;
  }

  nav {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.8rem;
  }

  a {
    min-height: 124px;
    padding: 1.1rem;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 1rem;
    border: 1px solid #d8d8d3;
    border-radius: 10px;
    background: #fff;
    color: inherit;
    text-decoration: none;
    transition: transform 0.12s, border-color 0.12s, box-shadow 0.12s;
  }

  a:hover {
    transform: translateY(-2px);
    border-color: #999;
    box-shadow: 0 8px 24px rgb(0 0 0 / 7%);
  }

  a strong { font-size: var(--font-size-medium); }
  a span { color: #777; font-size: var(--font-size-small); line-height: 1.4; }

  @media (max-width: 620px) {
    nav { grid-template-columns: 1fr; }
    a { min-height: 104px; }
  }
</style>
