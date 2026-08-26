export function installFocusModality(document: Document) {
  const root = document.documentElement;
  root.dataset.focusModality = "pointer";

  const handleKeyDown = () => {
    root.dataset.focusModality = "keyboard";
  };
  const handlePointerDown = () => {
    root.dataset.focusModality = "pointer";
  };

  document.addEventListener("keydown", handleKeyDown, true);
  document.addEventListener("pointerdown", handlePointerDown, true);

  return () => {
    document.removeEventListener("keydown", handleKeyDown, true);
    document.removeEventListener("pointerdown", handlePointerDown, true);
  };
}
