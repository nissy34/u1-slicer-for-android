// Port of app/src/main/java/com/u1/slicer/bambu/PaintColorDecoder.kt.
//
// B95 (#102) — faithful port of OrcaSlicer's `TriangleSelector::deserialize` for
// extracting the set of leaf paint states encoded in one triangle's `paint_color`
// (or `mmu_segmentation`) hex attribute.
//
// The hex string is read RIGHT-TO-LEFT (FacetsAnnotation::set_triangle_from_string
// iterates crbegin→crend); each hex char contributes 4 bits LSB-first. Nibbles:
//   bits 0-1 = num_of_split_sides (0 = leaf, 1/2/3 = split into 2/3/4 children)
//   bits 2-3 = state (0..2) for a leaf, or special_side for a split node.
//   Extended state: leaf with bits 2-3 == 0b11 → next nibble holds state-3; while
//   that nibble == 0b1111 keep reading (each adds 15).
//   Split node: recursively encodes `num_of_split_sides + 1` children depth-first.
//
// The old first-hex-char heuristic (ThreeMfParser.paintCharToState) disagrees for
// extended/split encodings: Buzz plate 9's "8C"/"3C" are states 11/6, not 8/3.

function hexNibble(code) {
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 65 && code <= 70) return code - 55; // A-F
  if (code >= 97 && code <= 102) return code - 87; // a-f
  return -1;
}

/**
 * Decodes one triangle's paint state tree; returns the Set of leaf states found.
 * Empty for blank or malformed input. State 0 (no paint) is NOT included.
 */
export function decodeStates(hexEncoded) {
  if (!hexEncoded) return new Set();

  // Bitstream: hex chars right-to-left, each contributing 4 bits LSB-first.
  const bits = new Uint8Array(hexEncoded.length * 4);
  let bitIdx = 0;
  for (let i = hexEncoded.length - 1; i >= 0; i--) {
    const nib = hexNibble(hexEncoded.charCodeAt(i));
    if (nib < 0) return new Set(); // malformed
    for (let b = 0; b <= 3; b++) bits[bitIdx++] = (nib & (1 << b)) !== 0 ? 1 : 0;
  }

  const states = new Set();
  let ibit = 0;
  // Pending-children stack: split nodes whose children are still being read.
  const pending = [];

  const nextNibble = () => {
    if (ibit + 4 > bits.length) return -1; // exhausted (malformed)
    let n = 0;
    for (let i = 0; i <= 3; i++) if (bits[ibit + i]) n |= 1 << i;
    ibit += 4;
    return n;
  };

  // Decrement the deepest pending count; pop and cascade to parents whose counts
  // hit zero (the C++ walk-back loop over parents.back().processed_children).
  const decrementParentChain = () => {
    while (pending.length > 0) {
      const last = pending.pop() - 1;
      if (last > 0) { pending.push(last); return; }
    }
  };

  for (;;) {
    const code = nextNibble();
    if (code < 0) break;

    const splitSides = code & 0b11;
    if (splitSides !== 0) {
      // Upper 2 bits are special_side (ignored); read splitSides + 1 children.
      pending.push(splitSides + 1);
    } else {
      let state;
      if ((code & 0b1100) === 0b1100) {
        let next = nextNibble();
        if (next < 0) break;
        let num = 0;
        while (next === 0b1111) {
          num++;
          next = nextNibble();
          if (next < 0) break;
        }
        if (next < 0) break;
        state = next + 15 * num + 3;
      } else {
        state = code >> 2;
      }
      if (state > 0) states.add(state);
      if (pending.length === 0) break; // root leaf — done
      decrementParentChain();
      if (pending.length === 0) break; // whole split tree consumed
    }
  }
  return states;
}

/** True if any leaf in `hexEncoded` has a non-zero state. */
export const hasAnyNonZeroState = (hexEncoded) => decodeStates(hexEncoded).size > 0;

/** Maximum 1-based filament state across all attribute strings, or 0 when none. */
export function maxState(hexAttributes) {
  let max = 0;
  for (const s of hexAttributes) for (const state of decodeStates(s)) if (state > max) max = state;
  return max;
}

export const PaintColorDecoder = { decodeStates, hasAnyNonZeroState, maxState };
