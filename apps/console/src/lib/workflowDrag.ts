/** The type a step from the list carries while it is dragged. */
export const STEP_DRAG_TYPE = "application/x-kairos-step";

/**
 * The step type being dragged from the list. A browser hides the dragged data until the drop,
 * and the canvas must know the type before it, to show only the slots the step fits.
 */
let dragged: string | null = null;

export const startStepDrag = (type: string) => void (dragged = type);
export const endStepDrag = () => void (dragged = null);
export const draggedStep = () => dragged;
