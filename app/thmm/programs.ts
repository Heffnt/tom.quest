/**
 * THCC source for every preset scenario. Kept in one file so the source
 * strings sit together and `scenarios.ts` reads as a clean menu.
 */

export const SIMPLE_THCC = `// Smallest useful test: store a constant and a sum.
int a = 5;
int b = 7;
int c = a + b;
`;

export const NESTED_THCC = `// The temp-stash dance: nested expressions force the compiler to
// shuffle intermediate values through scratch cells, because there is
// only one accumulator.
int a = 1;
int b = 2;
int c = 3;
int d = 4;
int z = (a + b) * (c + d);
`;

export const PYTHAGORAS_THCC = `// Pythagoras on a 3-4-5 right triangle. Expected: hyp_sq = 25.
//
int a = 4;
int b = 3;
int hyp_sq = a * a + b * b;
`;

export const REGRESSION_THCC = `// Ordinary least squares on three hand-picked points.
// Data lies exactly on y = 2x + 1, so expected result is w = 2, b = 1.

int n = 3;
int x0 = 1; int y0 = 3;
int x1 = 2; int y1 = 5;
int x2 = 3; int y2 = 7;

int sum_x  = x0 + x1 + x2;
int sum_y  = y0 + y1 + y2;
int sum_xy = x0 * y0 + x1 * y1 + x2 * y2;
int sum_xx = x0 * x0 + x1 * x1 + x2 * x2;

int w_num = n * sum_xy - sum_x * sum_y;
int w_den = n * sum_xx - sum_x * sum_x;
int w = w_num / w_den;
int b = (sum_y - w * sum_x) / n;
`;

export const EULER_E_THCC = `// Approximate e using a 7-term Taylor series, scaled by 1000.
//
//   e = 1/0! + 1/1! + 1/2! + 1/3! + 1/4! + 1/5! + 1/6!
//
// Working in scaled integers, expected total = 2716 (true e = 2.71828).
// The error of ~2 comes from integer-truncating each term.

int s  = 250 * 4;     // = 1000, the scale factor

int f1 = 1;
int f2 = 2;
int f3 = 6;
int f4 = 24;
int f5 = 120;
int f6 = f5 * 6;      // = 720

int t0 = s / f1;      // 1/0! * 1000  (0! = 1! = 1)
int t1 = s / f1;      // 1/1!
int t2 = s / f2;      // 1/2!
int t3 = s / f3;      // 1/3!
int t4 = s / f4;      // 1/4!
int t5 = s / f5;      // 1/5!
int t6 = s / f6;      // 1/6!

int e = t0 + t1 + t2 + t3 + t4 + t5 + t6;
`;

export const XOR_THCC = `// XOR network: a 1-layer "neural" net with hand-picked weights.
//
// XOR(x, y) = x + y - 2*x*y -- a polynomial whose two multiplications
// act as a soft AND. Forward-pass for all four input pairs.
//
// Outputs p_a, p_b, p_c, p_d should be 0, 1, 1, 0.

int x_a = 0; int y_a = 0;
int x_b = 0; int y_b = 1;
int x_c = 1; int y_c = 0;
int x_d = 1; int y_d = 1;

int xy_a = x_a * y_a;
int p_a  = x_a + y_a - xy_a - xy_a;

int xy_b = x_b * y_b;
int p_b  = x_b + y_b - xy_b - xy_b;

int xy_c = x_c * y_c;
int p_c  = x_c + y_c - xy_c - xy_c;

int xy_d = x_d * y_d;
int p_d  = x_d + y_d - xy_d - xy_d;
`;

export const PROJECTILE_THCC = `// Projectile motion via 11 unrolled forward-Euler steps.
//
// Cannon fired with horizontal velocity vx = 20, initial vertical
// velocity vy = 50, gravity g = 10. Each step advances (x, y) using
// the CURRENT vy, then decrements vy. Lands exactly at step 11 (y=0).

int vx = 20;
int vy0 = 50;
int g  = 10;
int x0 = 0;
int y0 = 0;

int y1  = y0 + vy0;
int vy1 = vy0 - g;
int x1  = x0 + vx;

int y2  = y1 + vy1;
int vy2 = vy1 - g;
int x2  = x1 + vx;

int y3  = y2 + vy2;
int vy3 = vy2 - g;
int x3  = x2 + vx;

int y4  = y3 + vy3;
int vy4 = vy3 - g;
int x4  = x3 + vx;

int y5  = y4 + vy4;
int vy5 = vy4 - g;
int x5  = x4 + vx;

int y6  = y5 + vy5;
int vy6 = vy5 - g;
int x6  = x5 + vx;

int y7  = y6 + vy6;
int vy7 = vy6 - g;
int x7  = x6 + vx;

int y8  = y7 + vy7;
int vy8 = vy7 - g;
int x8  = x7 + vx;

int y9  = y8 + vy8;
int vy9 = vy8 - g;
int x9  = x8 + vx;

int y10  = y9 + vy9;
int vy10 = vy9 - g;
int x10  = x9 + vx;

int y11  = y10 + vy10;
int vy11 = vy10 - g;
int x11  = x10 + vx;
`;

export const BEZIER_THCC = `// Cubic Bezier curve sampled at 5 points along T = 0, 1/4, 2/4, 3/4, 1.
//
// Control points form an arch:
//   P0 = (0, 0)   P1 = (0, 100)   P2 = (100, 100)   P3 = (100, 0)
//
// Bernstein basis weights are scaled by 64 so we work in integers and
// divide at the end. Expected (X_T, Y_T):
//   T=0: (  0,  0)   T=1: ( 15, 56)   T=2: ( 50, 75)
//   T=3: ( 84, 56)   T=4: (100,  0)

int K64 = 64;

int x0 = 0;   int y0 = 0;
int x1 = 0;   int y1 = 100;
int x2 = 100; int y2 = 100;
int x3 = 100; int y3 = 0;

// T=0: trivially the first control point.
int X0 = x0;
int Y0 = y0;

// T=1 basis = (27, 27, 9, 1) / 64
int b10 = 27; int b11 = 27; int b12 = 9; int b13 = 1;
int X1 = (b10*x0 + b11*x1 + b12*x2 + b13*x3) / K64;
int Y1 = (b10*y0 + b11*y1 + b12*y2 + b13*y3) / K64;

// T=2 basis = (8, 24, 24, 8) / 64
int b20 = 8;  int b21 = 24; int b22 = 24; int b23 = 8;
int X2 = (b20*x0 + b21*x1 + b22*x2 + b23*x3) / K64;
int Y2 = (b20*y0 + b21*y1 + b22*y2 + b23*y3) / K64;

// T=3 basis = (1, 9, 27, 27) / 64
int b30 = 1;  int b31 = 9;  int b32 = 27; int b33 = 27;
int X3 = (b30*x0 + b31*x1 + b32*x2 + b33*x3) / K64;
int Y3 = (b30*y0 + b31*y1 + b32*y2 + b33*y3) / K64;

// T=4: trivially the last control point.
int X4 = x3;
int Y4 = y3;
`;
