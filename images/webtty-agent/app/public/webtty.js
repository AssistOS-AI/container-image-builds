(() => {
  const TAB_ID = crypto.randomUUID();
  const body = document.body;
  const title = body.dataset.title || body.dataset.agent || 'Console';
  const requiresAuth = body.dataset.auth === 'true';
  const titleBar = document.getElementById('titleBar');
  const statusEl = document.getElementById('status');
  const statusDot = document.querySelector('.wa-status-dot');
  const sizeEl = document.getElementById('size');
  const themeToggle = document.getElementById('themeToggle');
  const containerName = document.getElementById('containerName');
  const runtime = document.getElementById('runtime');
  const requestedDir = new URLSearchParams(window.location.search).get('dir') || '';
  
  containerName.textContent = body.dataset.container || '-';
  runtime.textContent = body.dataset.runtime || '-';
  titleBar.textContent = title;

  function getTheme() {
    return localStorage.getItem('webtty_theme') || 'light';
  }

  function setTheme(t) {
    document.body.setAttribute('data-theme', t);
    localStorage.setItem('webtty_theme', t);
    try {
      term?.setOption('theme', t === 'dark' ? darkTheme : lightTheme);
    } catch(_) {}
  }
  
  themeToggle.onclick = () => { 
    const cur = getTheme(); 
    setTheme(cur === 'dark' ? 'light' : 'dark'); 
    location.reload();
  };
  
  setTheme(getTheme());

  async function ensureAuth() { 
    if (!requiresAuth) return true; 
    try { 
    const res = await fetch('whoami'); 
      return res.ok; 
    } catch(_) { 
      return false; 
    } 
  }
  
  (async () => { 
    if (!(await ensureAuth())) location.href = '.'; 
  })();

  const banner = document.getElementById('connBanner');
  const bannerText = document.getElementById('bannerText');
  
  function showBanner(text, cls) { 
    banner.className = 'wa-connection-banner show'; 
    if (cls === 'ok') banner.classList.add('success');
    else if (cls === 'err') banner.classList.add('error');
    bannerText.textContent = text; 
  }
  
  function hideBanner() { 
    banner.classList.remove('show'); 
  }

  // xterm
  let term, fitAddon;

  const darkTheme = {
    background: '#0a0b0d',
    foreground: '#e9edef',
    cursor: '#e9edef',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#e5e5e5'
  };

  const lightTheme = {
    background: '#ffffff',
    foreground: '#111b21',
    cursor: '#111b21',
    black: '#000000',
    red: '#cd3131',
    green: '#05a369',
    yellow: '#b58900',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#333333',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#05a369',
    brightYellow: '#b58900',
    brightBlue: '#2472c8',
    brightMagenta: '#bc3fbc',
    brightCyan: '#11a8cd',
    brightWhite: '#000000'
  };
  
  function initConsole() { 
    const termEl = document.getElementById('term'); 
    const { Terminal } = window; 
    const FitAddon = window.FitAddon.FitAddon; 
    const WebLinksAddon = window.WebLinksAddon.WebLinksAddon; 
    
    term = new Terminal({ 
      fontFamily: 'Menlo, Monaco, Consolas, monospace', 
      fontSize: 13, 
      theme: getTheme() === 'dark' ? darkTheme : lightTheme, 
      cursorBlink: true, 
      cursorStyle: 'bar', 
      allowProposedApi: true, 
      convertEol: true, 
      scrollback: 2000, 
      rendererType: 'canvas' 
    }); 
    
    fitAddon = new FitAddon(); 
    const links = new WebLinksAddon(); 
    term.loadAddon(fitAddon); 
    term.loadAddon(links); 
    term.open(termEl); 
    // do not focus by default; only on click
    
    try { 
      fitAddon.fit(); 
    } catch(_) {} 
    
    sizeEl.textContent = term.rows + ' × ' + term.cols; 
    termEl.addEventListener('mousedown', () => term.focus()); 
    // Observe container size changes (more robust than window resize only)
    /* Loop detected, disabling ResizeObserver
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => {
        try { fitAddon.fit(); } catch(_) {}
        // Also notify server on true size change
        try { sendResize(); } catch(_) {}
      });
      ro.observe(termEl);
    }
    */
  }
  
  function sendResize() { 
    try { 
      fitAddon.fit(); 
    } catch(_) {} 
    
    const cols = term.cols; 
    const rows = term.rows; 
    sizeEl.textContent = rows + ' × ' + cols; 
    
    fetch(`resize?tabId=${TAB_ID}`, { 
      method: 'POST', 
      headers: {'Content-Type': 'application/json'}, 
      body: JSON.stringify({ cols, rows }) 
    }).catch(() => {}); 
  }
  
  function bindIO() { 
    window.addEventListener('resize', sendResize); 
    setTimeout(sendResize, 120); 
    
    term.onData(data => { 
      fetch(`input?tabId=${TAB_ID}`, { 
        method: 'POST', 
        headers: {'Content-Type': 'text/plain'}, 
        body: data 
      }).catch(() => {}); 
    }); 
  }
  
  let es; 
  
  function startSSE() { 
    showBanner('Connecting…'); 
    
    try { 
      es?.close?.(); 
    } catch(_) {} 
    
    const streamParams = new URLSearchParams({ tabId: TAB_ID });
    if (requestedDir) streamParams.set('dir', requestedDir);
    es = new EventSource(`stream?${streamParams.toString()}`); 
    
    es.onopen = () => { 
      statusEl.textContent = 'connected';
      statusDot.classList.remove('offline');
      statusDot.classList.add('online');
      showBanner('Connected', 'ok'); 
      setTimeout(hideBanner, 800); 
    }; 
    
    es.onerror = () => { 
      statusEl.textContent = 'disconnected';
      statusDot.classList.remove('online');
      statusDot.classList.add('offline');
      try { es.close(); } catch(_) {}
      // Keep session cookie; try to auto-reconnect after a short delay
      setTimeout(() => { try { startSSE(); } catch(_) {} }, 1000);
    }; 
    
    es.onmessage = (ev) => { 
      try { 
        const text = JSON.parse(ev.data); 
        term.write(text); 
      } catch(_) {} 
    }; 
  }
  
  initConsole(); 
  startSSE(); 
  bindIO();
})();
