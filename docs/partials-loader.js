async function loadPartial(container) {
  const response = await fetch(container.dataset.include);
  if (!response.ok) throw new Error('Could not load ' + container.dataset.include);
  container.innerHTML = await response.text();
}
function closeMenus(except = null) {
  for (const menu of document.querySelectorAll('.nav-menu')) {
    if (menu === except) continue;
    menu.querySelector('button').setAttribute('aria-expanded', 'false');
    menu.querySelector('.menu-panel').hidden = true;
  }
}
document.addEventListener('click', event => {
  const button = event.target.closest('.nav-menu > button');
  if (button) {
    const menu = button.closest('.nav-menu');
    const open = button.getAttribute('aria-expanded') !== 'true';
    closeMenus();
    button.setAttribute('aria-expanded', String(open));
    menu.querySelector('.menu-panel').hidden = !open;
  } else if (!event.target.closest('.nav-menu')) closeMenus();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const button = document.querySelector('.nav-menu > button[aria-expanded="true"]');
  if (button) { closeMenus(); button.focus(); }
});
window.addEventListener('DOMContentLoaded', async () => {
  await Promise.all(Array.from(document.querySelectorAll('[data-include]'), async container => {
    try { await loadPartial(container); } catch (error) { container.textContent = error.message; }
  }));
  const title = document.querySelector('.site-title')?.textContent;
  const specTitle = document.getElementById('spec-title');
  if (title && specTitle) {
    const update = () => { document.title = specTitle.textContent + ' | ' + title; };
    new MutationObserver(update).observe(specTitle, { childList: true, subtree: true, characterData: true });
    update();
  }
});
