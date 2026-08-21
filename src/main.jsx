import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

const root = createRoot(document.getElementById('root'));

// Dev-only Csound spike (docs/CSOUND_PLAN.md steps 1 & 2), at ?csound=1.
// Imported DYNAMICALLY so @csound/browser and its wasm stay out of the normal
// app's bundle until the environment tabs land (step 5). StrictMode is kept on
// purpose: the double-mount is what proves the engine's memoised init really
// yields one Csound instance on one AudioContext.
if (new URLSearchParams(window.location.search).get('csound') === '1') {
  import('./components/CsoundSpike.jsx').then(({ default: CsoundSpike }) => {
    root.render(<React.StrictMode><CsoundSpike /></React.StrictMode>);
  });
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
