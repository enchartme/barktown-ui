<script>
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { fetchDiarySummary } from '$lib/diary-summary.js';
  import { probeEditingAccess } from '$lib/editing-access.js';
  import { isEmbeddedLayout } from '$lib/embed.js';
  import { formatDisturbedTime } from '$lib/report-summary.js';

  let recentSummary = $state({ records: 0, disturbedTimeSec: 0, barks: 0 });
  let summaryState = $state('loading');
  let operatorAccess = $state(false);
  const embedded = $derived(isEmbeddedLayout(page.url.searchParams));

  function todayInStockholm() {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Stockholm',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  onMount(async () => {
    const endDate = todayInStockholm();
    try {
      const summary = await fetchDiarySummary({
        startDate: '2026-08-01',
        endDate,
      });
      recentSummary = summary.totals;
      summaryState = 'ready';
    } catch (error) {
      console.error('Failed to load recent Barktown summary:', error);
      summaryState = 'error';
    }
  });

  onMount(() => {
    let disposed = false;
    void probeEditingAccess().then((available) => {
      if (!disposed) operatorAccess = available;
    });
    return () => { disposed = true; };
  });

  const sections = [
    {
      number: '01',
      id: 'purpose',
      label: 'Purpose',
      title: "What Barktown is and isn't",
      simple: 'Barktown listens for repeated dog-like sounds at one fixed location and turns them into a dated, reviewable diary. It does not identify a dog or decide where a sound came from.',
      more: 'The aim is consistent observation: preserve the time, surrounding audio and loudness measurements for sound events that are likely barks. The detector is trained to ignore people, birds, traffic and other noises, but it is not 100% accurate. A human would review and delete any mistakes.',
      technical: [
        'The measured target is a binary acoustic classification — wanted dog sounds (bark or yap) versus other local sounds — followed by a deterministic event-assembly step. The classifier emits a probability-like score; that score is evidence about acoustic similarity, not a calibrated probability that a particular dog barked.',
        'Each retained event has an audio clip and timestamps, so the automated result remains falsifiable by listening. The system performs no speaker identification, animal identification, direction finding or source localisation. A Barktown record is therefore a candidate acoustic event, not an attribution or legal conclusion.'
      ],
      media: '/images/mic-hanging.jpg',
      mediaNote: 'Directional microphone',
      mediaFullWidth: false,
      reverse: false
    },
    {
      number: '02',
      id: 'history',
      label: 'History',
      title: '6 years of barking disturbance',
      simple: 'This project started out of a frustration of not being able to rest at home. The problem did not appear yesterday. See the history below:',
      more: 'The dog disturbances were collected manually since 2021 and piled up on hard drives. Only in February 2026 have we made the Barktown visual diary to browse and listen the collected recordings. Later same year we acquired hardware and built the automatic AI detector.',
      technical: [
        '4120 manual disturbance text notes',
        '1295 manual disturbance audio recordings of disturbances'
      ],
      media: '/images/six-years-of-bark-disturbance.png',
      mediaNote: 'Project timeline',
      mediaFullWidth: true,
      reverse: true
    },
    {
      number: '03',
      id: 'sampling',
      label: 'Sampling',
      title: 'Collecting examples of barks',
      simple: 'The AI bark detector had to learn from local examples of sounds, so we made a system to record and label those. Apart of actual barks and yaps we have also collected examples of everything that is not a bark: traffic, wind, wildlife, homestead, etc',
      more: 'In each sample recordig we have manually labeled fragments that sound representative. These fragments are later sliced into yet finer portions called "windows" by the learning model called YAMNet, see the next section',
      technical: [
        'We have manually collected 679 sound samples using the exact hardware setup and location that would be later used for detection. Collecting samples took about a month and labeling fragments took about a week of work.', 
        'Manually labeled fragments are sliced into Windows that have a fixed length of 0.96s, as required by the sound classification neural network YAMNet. We discard windows that may have not enough information, such as the incomplete ones in the end of fragments — those may just include silence after barks'
      ],
      media: '/images/explanation-windows.png',
      mediaNote: 'Example of samples, fragmets and windows',
      mediaFullWidth: true,
      reverse: true
    },
    {
      number: '04',
      id: 'training',
      label: 'Training',
      title: 'How the AI was trained',
      simple: "YAMNet is a pre-trained deep learning model by Google that identifies 521 different audio event classes — like animal sounds, speech, or sirens — from an audio waveform. The Barktown learning happens on top of YAMNet's existing learning. This is called transfer learning. It lets us train a useful local detector with far fewer examples than would be required to build an audio model from scratch. An analogy would be hiring someone who already understands sound generally, then training them on the specific distinction that matters at this location.", 
      more: "Barktown uses YAMNet model as a sound-feature extractor: each short audio fragment is converted into a 1024-number “sound fingerprint” describing patterns YAMNet has already learned, such as rhythm, pitch and texture. Our labelled samples then train a much smaller Barktown classifier to interpret those fingerprints and learn the local distinction between bark/yap and everything else, with confusing negative examples deliberately included",      
      technical: [
        'Audio is mixed to mono, resampled to 16 kHz and passed through YAMNet. Its overlapping analysis windows are approximately 0.96 seconds long with a 0.48-second step, each producing a 1024-dimensional embedding. The custom part is that Barktown then trains a small classifier that combines 128 learned sound patterns and produces a single score for how bark-like the audio is. During training, some signals are randomly hidden to reduce memorisation. Training stops when performance on held-back audio no longer improves. The final cutoff balances detected barks against false alarms, favouring fewer false alarms when undecided.'
      ],
      links: [
        {label: "YAMNet", href: "https://www.kaggle.com/models/google/yamnet"}, 
        {label: "AudioSet", href: "https://research.google.com/audioset/"}
      ],
      media: '/images/training-windows.png',
      mediaNote: 'Training quality diagram',
      mediaFullWidth: true,
      reverse: true
    },
    {
      number: '05',
      id: 'detection',
      label: 'Detection',
      title: 'From sound to a diary record',
      simple: 'Barktown repeatedly checks recent sound, waits for several matching observations, then preserves a recording of the whole session. The result is uploaded, organised and placed in the diary for a human review.',
      more: 'Recent sound is held temporarily in memory. A clip is retained only after several bark-like observations support one event, with a small amount of sound before and after it for context. A single high score is not enough. The detector asks for repeated evidence within a time window, prevents one bark from being counted several times and joins nearby barks into one session. When the session is over, it saves the surrounding audio and sends both the recording and its measurements to the archive.',
      technical: [
        'The current instrument is a RØDE VideoMic NTG connected to a Raspberry Pi. The live stream is captured at 48 kHz and resampled to 16 kHz for YAMNet. A trailing 1.5-second buffer is scored every 0.25 seconds. Current bootstrap defaults require a score of at least 0.92, four accepted hits within a 30-second sliding window and at least 1.5 seconds between counted hits. That minimum separation — called hit refractory in the code — stops overlapping analysis windows from double-counting barks.',

        'A deterministic state machine moves through IDLE → ACTIVE_CANDIDATE → ACTIVE_CONFIRMED → COOLDOWN. A 120-second sub-threshold gap closes the current session in the boot configuration; renewed barking during cooldown reopens it. Audio is encoded in memory, uploaded to MinIO, validated by the ingest service, indexed in SQLite and exposed to the UI with waveform and per-hit metadata.',

      
        'The live device uses an in-memory ring buffer, avoiding continuous day-long audio storage and unnecessary writes to the Pi’s SD card. In the current bootstrap configuration the buffer holds 700 seconds, confirmed events can extend to 570 seconds, and 1.5 seconds of padding is added at each end before upload. Detector parameters are stored in the API/database and can be updated during runtime.',

     
      ],
      media: '/images/detection-flow.png',
      mediaNote: 'Detection pipeline',
      mediaFullWidth: true,
      reverse: true
    },
    {
      number: '06',
      id: 'architecture',
      label: 'Architecture',
      title: 'It got complicated',
      simple: 'Listening, storage and presentation are separate parts of the system. The detector can keep working if the web page is closed, while recordings remain available for later review.',
      more: 'The field device runs the microphone and detector. A second service validates uploads, stores audio and metadata, and provides the application interface. The Barktown website reads that interface to show the diary, reports and training workspace; laptop tools handle calibration, data inspection and model training.',
      technical: [
        'The runtime is split across four version-controlled repositories: the SvelteKit UI, the Python Raspberry Pi monitor, the Node/SQLite ingest API and the Python training/calibration utilities. Audio objects live in S3-compatible MinIO storage; diary, annotation, detector-parameter and provenance records live in SQLite. The API is the persistent source of truth for live tuning, while checked configuration supplies validated first-boot fallbacks.',
        'Model artifacts are deployed as a TFLite classifier plus adjacent metadata; the runtime verifies the declared filename and SHA-256 before loading a new bundle. The same scoring and hit-gating core is reused for live inference and offline re-analysis, reducing the risk that the review path silently applies different rules.',
        'Operational status includes microphone presence, stream state, sample rate, recent RMS and peak levels, clipping, x-runs, CPU temperature, storage, network reachability and upload counters. The monitor and its status service run separately, so observation of the instrument does not share the detector’s main process.'
      ],
      links: [
        { label: 'UI', href: 'https://github.com/enchartme/barktown-ui' },
        { label: 'Monitor', href: 'https://github.com/enchartme/barktown-goblin' },
        { label: 'Server', href: 'https://github.com/enchartme/barktown-server' },
        { label: 'Training tools', href: 'https://github.com/enchartme/barktown-utils' }
      ],
      media: '/images/system-architecture.png',
      mediaNote: 'System Architecture',
      mediaFullWidth: true,
      reverse: true
    },
    {
      number: '07',
      id: 'presentation',
      label: 'Presentation',
      title: 'Visual presentations',
      simple: 'The diary shows when a suspected event happened, and the report shows patterns across two weeks. Every result leads back to playable audio so a reviewer can check the system rather than trust a number on its own.',
      more: 'Recordings appear on a time-of-day timeline with waveforms, labels and notes. Weekly summaries count events and describe their distribution, while confidence and relative loudness help find recordings worth closer inspection. Reviewers can correct false positives and re-run archived material with the current model.',
      technical: [
        'Each accepted hit can carry a timestamp, classifier confidence and loudness relative to below-threshold windows in the same clip. Event-level records include duration, peak and mean score, hit count, hit density and maximum/mean loudness ratios. These are descriptive diagnostics; they are not sound-level-meter readings and should not be interpreted as calibrated decibels at a property boundary.',
        'Offline re-analysis records model and settings provenance alongside its results, allowing a reviewer to distinguish the original detector output from a later model’s interpretation. The UI preserves the audio as the primary evidence and presents derived metrics as aids to navigation and quality control.'
      ],
      media: '/images/diary-view.png',
      mediaNote: 'Suggested: one diary event beside its corresponding two-week summary.',
      mediaFullWidth: false,
      reverse: false
    },{
      number: '08',
      id: 'limitations',
      label: 'Limitations',
      title: 'No free lunch',
      simple: 'The system hsa imperfections',
      more: '',
      technical: [
        'This is event-triggered sampling. It is efficient and privacy-conscious, but it has an important evidentiary limit: saved clips can confirm what the detector captured, while the absence of a clip does not by itself prove the absence of barking. Training fragments retain their parent recording and time bounds so their provenance can be traced.'
      ],
      media: '/images/report-view-wide.png',
      mediaNote: 'Suggested: one diary event beside its corresponding two-week summary.',
      mediaFullWidth: true,
      reverse: true
    }
  ];
</script>

<svelte:head>
  <title>Method · Barktown</title>
  <meta
    name="description"
    content="How Barktown captures, detects, reviews and reports dog-like sounds — from field setup to model training."
  />
</svelte:head>

<div class="page-shell">
  {#if !embedded}<header class="site-header">
    <a class="brand" href="/"><img class="brand-logo" src="/logo.png" alt="" width="144" height="144" /> Barktown</a>
    <nav aria-label="Barktown views">
      <a href="/diary">Diary</a>
      <a href="/report">Report</a>
      <a href="/training">Training</a>
      {#if operatorAccess}<a href="/quality">Quality</a>{/if}
      <a class="current" aria-current="page" href="/method">Method</a>
    </nav>
  </header>{/if}

  <main>
    <section class="hero" aria-labelledby="method-title">
      <div class="hero-copy">
        <p class="eyebrow">Research method · August 2026</p>
        <h1 id="method-title">AI-powered dog bark detector</h1>
        <p class="lede">
          Barktown is a field instrument for documenting dog barks over time.
          This page explains how the bark sounds are detected, captured and presented.
        </p>
        <p class="reading-note">
          Designed and built by Angie Hjort, <a href="https://enchart.me">Encharted Media AB</a>
        </p>
      </div>

      <div class="hero-side">
        <img
          class="hero-image"
          src="/images/angie-fixing.jpg"
          alt="Angie adjusting the Barktown field instrument outdoors"
        />
        <dl class="evidence-facts">
          <div><dt>Barks detected</dt><dd>{summaryState === 'ready' ? recentSummary.barks.toLocaleString() : summaryState === 'error' ? 'Unavailable' : 'Loading…'}</dd></div>
          <div><dt>Time barking</dt><dd>{summaryState === 'ready' ? formatDisturbedTime(recentSummary.disturbedTimeSec) : summaryState === 'error' ? 'Unavailable' : 'Loading…'}</dd></div>
          <div><dt>Disturbance events</dt><dd>{summaryState === 'ready' ? recentSummary.records.toLocaleString() : summaryState === 'error' ? 'Unavailable' : 'Loading…'}</dd></div>
          <div><dt>Counting since</dt><dd>1 August 2026</dd></div>
        </dl>
      </div>
    </section>

    <nav class="contents" aria-label="Method sections">
      <span>On this page</span>
      {#each sections as section}
        <a href={`#${section.id}`}><small>{section.number}</small>{section.label}</a>
      {/each}
    </nav>

    <div class="method-sections">
      {#each sections as section}
        <section
          class:reverse={section.reverse}
          class:media-full-width={section.mediaFullWidth}
          class="method-section"
          id={section.id}
        >
          <article class="section-copy">
            <div class="section-heading">
              <span class="section-number">{section.number}</span>
              <div>
                <p class="section-label">{section.label}</p>
                <h2>{section.title}</h2>
              </div>
            </div>

            <p class="simple-copy">{section.simple}</p>

            <details class="learn-more">
              <summary>
                <span>Learn more</span>
                <span class="disclosure-icon" aria-hidden="true"></span>
              </summary>
              <div class="more-content">
                <p>{section.more}</p>

                <details class="technical-details">
                  <summary>
                    <span>Technical details</span>
                    <span class="disclosure-icon" aria-hidden="true"></span>
                  </summary>
                  <div class="technical-content">
                    {#each section.technical as paragraph}
                      <p>{paragraph}</p>
                    {/each}

                    {#if section.links}
                      <div class="code-links" aria-label="Source repositories">
                        {#each section.links as link}
                          <a href={link.href} target="_blank" rel="noreferrer">{link.label}<span aria-hidden="true">↗</span></a>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </details>
              </div>
            </details>
          </article>

          <figure class="media-slot">
            {#if section.media.startsWith('/')}
              <img
                class="section-media"
                src={section.media}
                alt={section.mediaAlt ?? section.title}
                loading="lazy"
              />
            {:else}
              <div class="media-placeholder">
                <span class="slot-kicker">Picture / diagram space</span>
                <strong>{section.media}</strong>
              </div>
            {/if}
            <figcaption>{section.mediaNote}</figcaption>
          </figure>
        </section>
      {/each}
    </div>

    {#if !embedded}<section class="claim-boundary" aria-labelledby="claim-title">
      <div>
        <p class="eyebrow">The honest boundary</p>
        <h2 id="claim-title">What the record can support</h2>
      </div>
      <div class="boundary-grid">
        <div>
          <h3>It can show</h3>
          <p>What is audible in a retained clip, when that clip was captured, how the detector responded and whether similar retained events recur.</p>
        </div>
        <div>
          <h3>It cannot show by itself</h3>
          <p>Which dog made a sound, where it was located, every bark that occurred, or whether the evidence meets a legal definition of nuisance.</p>
        </div>
      </div>
    </section>{/if}
  </main>

  {#if !embedded}<footer>
    <a class="brand" href="/"><img class="brand-logo" src="/logo.png" alt="" width="144" height="144" /> Barktown</a>
    <p>Document the method. Preserve the recording. Keep the conclusion reviewable.</p>
    <a class="top-link" href="#method-title">Back to top ↑</a>
  </footer>{/if}
</div>

<style>
  :global(*, *::before, *::after) { box-sizing: border-box; }
  :global(html) { scroll-behavior: smooth; }
  :global(body) {
    margin: 0;
    background: #f3f1eb;
    color: #17211d;
    font-family: var(--font-body);
  }

  :global(::selection) { background: #c7dfd4; }

  .page-shell { min-height: 100dvh; overflow: clip; }

  .site-header {
    position: sticky;
    top: 0;
    z-index: 20;
    min-height: 52px;
    padding: 0.65rem clamp(1rem, 4vw, 3.5rem);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
    background: rgb(250 249 246 / 94%);
    border-bottom: 1px solid #d8d6cf;
    backdrop-filter: blur(12px);
  }

  .brand {
    color: #17211d;
    font-size: var(--font-size-medium);
    font-weight: 750;
    text-decoration: none;
    white-space: nowrap;
  }

  .site-header nav { display: flex; align-items: center; gap: 0.2rem; }
  .site-header nav a {
    padding: 0.35rem 0.6rem;
    border-radius: 4px;
    color: #55625c;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    text-decoration: none;
  }
  .site-header nav a:hover,
  .site-header nav a.current { background: #e8e6df; color: #17211d; }
  .site-header nav a.current { font-weight: 700; }

  main { max-width: 1440px; margin: 0 auto; }

  .hero {
    min-height: 620px;
    padding: clamp(4rem, 9vw, 8rem) clamp(1rem, 6vw, 6rem) clamp(3rem, 7vw, 6rem);
    display: grid;
    grid-template-columns: minmax(0, 1.25fr) minmax(300px, 0.75fr);
    align-items: center;
    gap: clamp(3rem, 7vw, 8rem);
  }

  .eyebrow,
  .section-label,
  .slot-kicker {
    margin: 0;
    color: #2d7058;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-weight: 800;
    text-transform: uppercase;
  }

  h1,
  h2 {
    font-family: var(--font-heading);
    font-weight: var(--font-heading-weight);
  }

  h1 {
    max-width: 900px;
    margin: 1rem 0 1.4rem;
    font-size: var(--font-size-xlarge);
    line-height: 0.95;
  }

  .lede {
    max-width: 750px;
    margin: 0;
    color: #384740;
    font-size: var(--font-size-medium);
    line-height: 1.55;
  }

  .reading-note {
    max-width: 640px;
    margin: 2.1rem 0 0;
    padding-left: 1rem;
    border-left: 2px solid #2d7058;
    color: #6b756f;
    font-size: var(--font-size-small);
    line-height: 1.55;
  }

  .reading-note strong { color: #384740; }

  .hero-side { align-self: stretch; display: flex; flex-direction: column; justify-content: center; }
  .media-placeholder {
    position: relative;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    gap: 0.45rem;
    overflow: hidden;
    border: 1px dashed #8fa097;
    background:
      linear-gradient(135deg, transparent 49.75%, rgb(45 112 88 / 10%) 50%, transparent 50.25%),
      linear-gradient(45deg, transparent 49.75%, rgb(45 112 88 / 10%) 50%, transparent 50.25%),
      #e5e7df;
    background-size: 32px 32px;
  }

  .hero-image {
    width: 100%;
    min-height: 310px;
    aspect-ratio: 3 / 2;
    display: block;
    object-fit: cover;
    object-position: center;
  }

  .media-placeholder::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(to top, rgb(229 231 223 / 96%), transparent 55%);
    pointer-events: none;
  }

  .media-placeholder > * { position: relative; z-index: 1; }

  .evidence-facts {
    margin: 0;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    border: 1px solid #d1d4cc;
    border-top: 0;
  }
  .evidence-facts div { min-height: 82px; padding: 1rem; border-right: 1px solid #d1d4cc; border-top: 1px solid #d1d4cc; }
  .evidence-facts div:nth-child(even) { border-right: 0; }
  .evidence-facts dt { margin-bottom: 0.35rem; color: #7a847f; font-family: var(--font-tiny); font-size: var(--font-size-tiny); font-weight: 750; text-transform: uppercase; }
  .evidence-facts dd { margin: 0; font-size: var(--font-size-small); font-weight: 650; line-height: 1.35; }

  .contents {
    margin: 0 clamp(1rem, 4vw, 3.5rem);
    padding: 1.1rem 0;
    display: flex;
    align-items: center;
    gap: 1.2rem;
    overflow-x: auto;
    border-top: 1px solid #c9c7c0;
    border-bottom: 1px solid #c9c7c0;
    scrollbar-width: none;
  }
  .contents::-webkit-scrollbar { display: none; }
  .contents > span { margin-right: auto; color: #7a817d; font-family: var(--font-tiny); font-size: var(--font-size-tiny); font-weight: 750; text-transform: uppercase; white-space: nowrap; }
  .contents a { display: inline-flex; align-items: baseline; gap: 0.3rem; color: #34433c; font-family: var(--font-tiny); font-size: var(--font-size-tiny); font-weight: 650; text-decoration: none; white-space: nowrap; }
  .contents a:hover { color: #2d7058; }
  .contents small { color: #97a09b; font-family: var(--font-tiny); font-size: var(--font-size-tiny); font-variant-numeric: tabular-nums; }

  .method-sections { padding: 0 clamp(1rem, 4vw, 3.5rem); }
  .method-section {
    min-height: 620px;
    padding: clamp(4.5rem, 8vw, 8rem) clamp(0rem, 2vw, 2.5rem);
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(320px, 0.78fr);
    align-items: center;
    gap: clamp(3rem, 8vw, 9rem);
    border-bottom: 1px solid #c9c7c0;
    scroll-margin-top: 70px;
  }
  .method-section.reverse .section-copy { order: 2; }
  .method-section.reverse .media-slot { order: 1; }
  .method-section.media-full-width {
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
    gap: clamp(2.5rem, 5vw, 5rem);
  }
  .method-section.media-full-width .section-copy,
  .method-section.media-full-width .media-slot {
    order: initial;
  }
  .method-section.media-full-width .media-slot {
    width: 100%;
    max-width: none;
  }
  .method-section.media-full-width .section-media {
    height: auto;
    aspect-ratio: auto;
  }
  .method-section.media-full-width .media-placeholder {
    width: 100%;
    min-height: 320px;
    aspect-ratio: 16 / 7;
  }

  .section-copy { max-width: 720px; }
  .section-heading { display: flex; align-items: flex-start; gap: 1rem; }
  .section-number { padding-top: 0.3rem; color: #819089; font-family: var(--font-monospace); font-size: var(--font-size-tiny); }
  .section-label { margin-bottom: 0.5rem; }
  .section-heading h2 { margin: 0; font-size: var(--font-size-xlarge); line-height: 1; }
  .simple-copy { margin: 2rem 0 0; color: #283832; font-size: var(--font-size-medium); line-height: 1.62; }

  details summary { list-style: none; }
  details summary::-webkit-details-marker { display: none; }
  details summary:focus-visible { outline: 3px solid rgb(45 112 88 / 25%); outline-offset: 4px; }

  .learn-more { margin-top: 1.7rem; border-top: 1px solid #c9cec7; }
  .learn-more > summary,
  .technical-details > summary {
    padding: 0.85rem 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    color: #236047;
    font-size: var(--font-size-small);
    font-weight: 800;
    cursor: pointer;
  }
  .learn-more > summary:hover span:first-child,
  .technical-details > summary:hover span:first-child { text-decoration: underline; text-underline-offset: 0.2em; }

  .disclosure-icon { position: relative; width: 14px; height: 14px; flex: 0 0 14px; }
  .disclosure-icon::before,
  .disclosure-icon::after { content: ''; position: absolute; background: currentColor; transition: transform 0.18s ease; }
  .disclosure-icon::before { top: 6px; left: 1px; width: 12px; height: 1px; }
  .disclosure-icon::after { top: 1px; left: 6px; width: 1px; height: 12px; }
  details[open] > summary .disclosure-icon::after { transform: rotate(90deg); }

  .more-content { padding: 0.25rem 0 0; }
  .more-content > p,
  .technical-content p { margin: 0 0 1rem; color: #53615b; font-size: var(--font-size-small); line-height: 1.7; }
  .technical-details { margin-top: 1.2rem; border-top: 1px solid #d8dad4; border-bottom: 1px solid #d8dad4; }
  .technical-details > summary { color: #354a41; font-family: var(--font-monospace); font-size: var(--font-size-tiny); }
  .technical-content { padding: 0.3rem 0 0.5rem; }
  .technical-content p { color: #606b66; font-size: var(--font-size-small); }

  .code-links { margin: 1.2rem 0 0.5rem; display: flex; flex-wrap: wrap; gap: 0.45rem; }
  .code-links a { padding: 0.45rem 0.65rem; display: inline-flex; gap: 0.55rem; border: 1px solid #c5cbc5; border-radius: 3px; color: #2d5b49; font-family: var(--font-monospace); font-size: var(--font-size-tiny); text-decoration: none; }
  .code-links a:hover { background: #e3e8e2; border-color: #8da295; }

  .media-slot { margin: 0; }
  .section-media {
    width: 100%;
    aspect-ratio: 4 / 3;
    display: block;
    background: #e5e7df;
    object-fit: contain;
  }
  .media-placeholder { aspect-ratio: 4 / 3; padding: 1.2rem; }
  .media-placeholder strong { max-width: 280px; font-family: var(--font-heading); font-size: var(--font-size-large); font-weight: var(--font-heading-weight); }
  figcaption { margin-top: 0.7rem; color: #78817d; font-family: var(--font-tiny); font-size: var(--font-size-tiny); line-height: 1.45; }

  .claim-boundary {
    margin: clamp(4rem, 9vw, 9rem) clamp(1rem, 6vw, 6rem);
    padding: clamp(2rem, 5vw, 4.5rem);
    display: grid;
    grid-template-columns: minmax(220px, 0.65fr) minmax(0, 1.35fr);
    gap: clamp(2rem, 7vw, 7rem);
    background: #193c30;
    color: #f2f2ec;
  }
  .claim-boundary .eyebrow { color: #9fceb9; }
  .claim-boundary h2 { max-width: 420px; margin: 0.8rem 0 0; font-size: var(--font-size-xlarge); line-height: 0.98; }
  .boundary-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2rem; }
  .boundary-grid h3 { margin: 0 0 0.7rem; color: #b8dccb; font-family: var(--font-heading); font-size: var(--font-size-tiny); text-transform: uppercase; }
  .boundary-grid p { margin: 0; color: #d5e0db; font-size: var(--font-size-small); line-height: 1.7; }

  footer {
    min-height: 120px;
    padding: 2rem clamp(1rem, 4vw, 3.5rem);
    display: flex;
    align-items: center;
    gap: 2rem;
    border-top: 1px solid #c9c7c0;
  }
  footer p { margin: 0; color: #68736d; font-family: var(--font-tiny); font-size: var(--font-size-tiny); }
  .top-link { margin-left: auto; color: #2d5b49; font-family: var(--font-tiny); font-size: var(--font-size-tiny); text-decoration: none; }

  @media (max-width: 900px) {
    .hero { grid-template-columns: 1fr; min-height: auto; }
    .hero-side { width: min(100%, 620px); }
    .method-section,
    .method-section.reverse { grid-template-columns: 1fr; min-height: 0; gap: 2.5rem; }
    .method-section.reverse .section-copy,
    .method-section.reverse .media-slot { order: initial; }
    .section-copy { max-width: 760px; }
    .media-slot { width: min(100%, 620px); }
    .claim-boundary { grid-template-columns: 1fr; }
  }

  @media (max-width: 620px) {
    .site-header { align-items: flex-start; flex-direction: column; gap: 0.45rem; }
    .site-header nav { width: 100%; overflow-x: auto; }
    .site-header nav a:first-child { margin-left: -0.6rem; }
    .hero { padding-top: 4rem; }
    h1 { font-size: var(--font-size-xlarge); }
    .hero-image { min-height: 230px; }
    .contents { margin-inline: 1rem; }
    .contents > span { display: none; }
    .method-sections { padding-inline: 1rem; }
    .method-section { padding-block: 4rem; }
    .section-heading { gap: 0.65rem; }
    .simple-copy { margin-top: 1.5rem; }
    .boundary-grid { grid-template-columns: 1fr; }
    footer { align-items: flex-start; flex-direction: column; gap: 0.8rem; }
    .top-link { margin-left: 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    :global(html) { scroll-behavior: auto; }
    .disclosure-icon::after { transition: none; }
  }
</style>
