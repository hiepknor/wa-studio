interface ModalLayerRegistration {
  layer: HTMLElement;
  returnFocus: HTMLElement | null;
}

const layers: ModalLayerRegistration[] = [];
const originalInert = new Map<HTMLElement, boolean>();
let originalBodyOverflow = "";
let rootReturnFocus: HTMLElement | null = null;
let bodyObserver: MutationObserver | null = null;
let focusRevision = 0;

function bodyElements() {
  return Array.from(document.body.children)
    .filter((element): element is HTMLElement => element instanceof HTMLElement);
}

function applyIsolation() {
  const topLayer = layers[layers.length - 1]?.layer;
  if (!topLayer) return;
  for (const element of bodyElements()) {
    if (!originalInert.has(element)) originalInert.set(element, element.inert);
    element.inert = element !== topLayer;
  }
  document.body.style.overflow = "hidden";
}

function scheduleFocus(target: HTMLElement | null) {
  const revision = ++focusRevision;
  queueMicrotask(() => {
    if (
      revision === focusRevision
      && target?.isConnected
      && !target.inert
      && !target.closest("[inert]")
    ) target.focus();
  });
}

/**
 * Owns application isolation for every body-level modal portal as one stack.
 * Snapshotting per component is not safe when two layers close in the same commit.
 */
export function acquireModalIsolation(
  layer: HTMLElement,
  returnFocus: HTMLElement | null,
) {
  focusRevision += 1;
  if (layers.length === 0) {
    originalBodyOverflow = document.body.style.overflow;
    rootReturnFocus = returnFocus;
    bodyObserver = new MutationObserver(applyIsolation);
    bodyObserver.observe(document.body, { childList: true });
  }

  const registration = { layer, returnFocus };
  layers.push(registration);
  applyIsolation();
  let released = false;

  return () => {
    if (released) return;
    released = true;
    const index = layers.indexOf(registration);
    if (index < 0) return;
    const wasTopLayer = index === layers.length - 1;
    layers.splice(index, 1);

    if (layers.length > 0) {
      applyIsolation();
      if (wasTopLayer) scheduleFocus(returnFocus);
      return;
    }

    bodyObserver?.disconnect();
    bodyObserver = null;
    for (const [element, inert] of originalInert) element.inert = inert;
    originalInert.clear();
    document.body.style.overflow = originalBodyOverflow;
    const finalReturnFocus = rootReturnFocus;
    rootReturnFocus = null;
    scheduleFocus(finalReturnFocus);
  };
}
