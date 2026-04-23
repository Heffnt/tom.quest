/**
 * Fibonacci program for THMM, hand-encoded as 16-bit strings.
 *
 * Mirrors THMM/fib.py from the sibling repo; see that file for the full
 * annotated listing with mnemonic + effect per line. With n=5 the loop
 * runs five iterations and Acc halts at F(6) = 8 under F(1)=F(2)=1.
 *
 * Data layout after setup:
 *   RAM[21] = n   (loop counter, starts at 5)
 *   RAM[22] = i   (constant 1)
 *   RAM[24] = A   (current term, starts at 1)
 *   RAM[25] = B   (previous term, implicit 0 via reset state)
 *   RAM[26] = t   (scratch temp)
 */
export const FIB_PROGRAM: string[] = [
  "0011000000000101", //  0:      loadn 5
  "0100000000010101", //  1:      store 21
  "0011000000000001", //  2:      loadn 1
  "0100000000010110", //  3:      store 22
  "0100000000011000", //  4:      store 24
  "0010000000010101", //  5:      loadm 21
  "1001000000010001", //  6 (L):  goif0 17
  "0010000000011000", //  7:      loadm 24
  "0100000000011010", //  8:      store 26
  "0111000000011001", //  9:      addm  25
  "0100000000011000", // 10:      store 24
  "0010000000011010", // 11:      loadm 26
  "0100000000011001", // 12:      store 25
  "0010000000010101", // 13:      loadm 21
  "1010000000010110", // 14:      subm  22
  "0100000000010101", // 15:      store 21
  "0101000000000110", // 16:      goto  6
  "0010000000011000", // 17 (H):  loadm 24
  "0001000000000000", // 18:      halt
];

/**
 * Source form users see in the editor — one bit string per line, with an
 * inline `//` comment describing the line. The parser tolerates comments,
 * blank lines, and whitespace; see parseProgram in program-editor.tsx.
 */
export const FIB_SOURCE = `0011000000000101  // 0:      loadn 5
0100000000010101  // 1:      store 21
0011000000000001  // 2:      loadn 1
0100000000010110  // 3:      store 22
0100000000011000  // 4:      store 24
0010000000010101  // 5:      loadm 21
1001000000010001  // 6 (L):  goif0 17
0010000000011000  // 7:      loadm 24
0100000000011010  // 8:      store 26
0111000000011001  // 9:      addm  25
0100000000011000  // 10:     store 24
0010000000011010  // 11:     loadm 26
0100000000011001  // 12:     store 25
0010000000010101  // 13:     loadm 21
1010000000010110  // 14:     subm  22
0100000000010101  // 15:     store 21
0101000000000110  // 16:     goto  6
0010000000011000  // 17 (H): loadm 24
0001000000000000  // 18:     halt
`;
