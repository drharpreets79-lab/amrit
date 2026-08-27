/**
 * The distribution functions the regression detectors need, and nothing more.
 *
 * Written rather than depended upon. The desktop bundle is shipped to ministries and every
 * dependency is a supply-chain surface and a licence to record; a normal quantile and a
 * Student-t tail do not justify either. Each function below is a published algorithm with
 * its reference, and each is tested against values from R — which is the implementation
 * these numbers have to agree with, because `farrington.ts` is validated against R's
 * `surveillance` package and a threshold that differs by a quantile is a threshold that
 * differs.
 *
 * Accuracy targets are stated per function. None of these are general-purpose: they are
 * accurate over the ranges the detectors actually use and are not intended for extreme
 * tails.
 */

/** Standard normal density. */
export function dnorm(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)
}

/**
 * Standard normal distribution function.
 *
 * Two regimes, each converging fast where it is used: the Maclaurin series for `erf` near
 * the centre, and a continued fraction for the complementary function in the tail. Both are
 * iterated to a relative tolerance rather than truncated at a fixed order, so the accuracy
 * is set by the tolerance and not by a fitted polynomial. Agreement with R is asserted in
 * `app/tests/detection-statistics.test.ts`.
 */
export function pnorm(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2))
}

/** Error function, ~1e-15 relative across the range these detectors use. */
export function erf(x: number): number {
  const z = Math.abs(x)
  if (z < 1e-15) return (2 / Math.sqrt(Math.PI)) * x
  let result: number
  if (z < 3) {
    let term = z
    let sum = z
    for (let n = 1; n < 300; n += 1) {
      term *= -z * z / n
      const add = term / (2 * n + 1)
      sum += add
      if (Math.abs(add) < 1e-18 * Math.abs(sum)) break
    }
    result = (2 / Math.sqrt(Math.PI)) * sum
  } else {
    // Continued fraction for erfc: exp(-z^2)/(z*sqrt(pi)) * 1/(1 + 1/(2z^2) / (1 + 2/(2z^2) / ...)),
    // evaluated backwards, which is stable for z above about 2.
    let fraction = 0
    for (let n = 80; n >= 1; n -= 1) fraction = (n / 2) / (z + fraction)
    const complement = Math.exp(-z * z) / Math.sqrt(Math.PI) / (z + fraction)
    result = 1 - complement
  }
  return x >= 0 ? result : -result
}

/**
 * Standard normal quantile.
 *
 * Wichura's AS 241 algorithm PPND16, accurate to about 1e-16 over the whole range.
 * Wichura MJ. Algorithm AS 241: The percentage points of the normal distribution. Applied
 * Statistics 1988;37:477-484. doi:10.2307/2347330
 */
export function qnorm(p: number): number {
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  const q = p - 0.5
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q
    return q * (((((((2509.0809287301227 * r + 33430.57558358813) * r + 67265.7709270087) * r
      + 45921.95393154987) * r + 13731.69376550946) * r + 1971.5909503065513) * r
      + 133.14166789178438) * r + 3.3871328727963665)
      / (((((((5226.495278852546 * r + 28729.085735721943) * r + 39307.89580009271) * r
        + 21213.794301586597) * r + 5394.196021424751) * r + 687.1870074920579) * r
        + 42.31333070160091) * r + 1)
  }
  let r = q < 0 ? p : 1 - p
  r = Math.sqrt(-Math.log(r))
  let value: number
  if (r <= 5) {
    r -= 1.6
    value = (((((((0.0007745450142783414 * r + 0.022723844989269184) * r + 0.2417807251774506) * r
      + 1.2704582524523684) * r + 3.6478483247632045) * r + 5.769497221460691) * r
      + 4.630337846156546) * r + 1.4234371107496835)
      / (((((((1.0507500716444169e-09 * r + 0.0005475938084995345) * r + 0.015198666563616457) * r
        + 0.14810397642748008) * r + 0.6897673349851) * r + 1.6763848301838038) * r
        + 2.053191626637759) * r + 1)
  } else {
    r -= 5
    value = (((((((2.0103343992922881e-07 * r + 2.7115555687434876e-05) * r + 0.0012426609473880784) * r
      + 0.026532189526576124) * r + 0.29656057182850487) * r + 1.7848265399172913) * r
      + 5.463784911164114) * r + 6.657904643501103)
      / (((((((2.0442631033899397e-15 * r + 1.421511758316446e-07) * r + 1.8463183175100548e-05) * r
        + 0.0007868691311456133) * r + 0.014875361290850615) * r + 0.1369298809227358) * r
        + 0.599832206555888) * r + 1)
  }
  return q < 0 ? -value : value
}

/** Log gamma, Lanczos approximation, ~1e-14 relative. */
export function logGamma(x: number): number {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x)
  const z = x - 1
  let a = 0.99999999999980993
  for (let index = 0; index < g.length; index += 1) a += (g[index] as number) / (z + index + 1)
  const t = z + g.length - 0.5
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a)
}

/**
 * Regularized incomplete beta function, by the continued fraction of Lentz.
 *
 * Numerical Recipes 3rd edition §6.4. Accurate to ~1e-14 away from the endpoints.
 */
export function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b)
    + a * Math.log(x) + b * Math.log(1 - x))
  if (x > (a + 1) / (a + b + 2)) return 1 - incompleteBeta(b, a, 1 - x)
  const tiny = 1e-30
  let c = 1
  let d = 1 - (a + b) * x / (a + 1)
  if (Math.abs(d) < tiny) d = tiny
  d = 1 / d
  let h = d
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m
    let numerator = m * (b - m) * x / ((a + m2 - 1) * (a + m2))
    d = 1 + numerator * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + numerator / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    h *= d * c
    numerator = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1))
    d = 1 + numerator * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + numerator / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const delta = d * c
    h *= delta
    if (Math.abs(delta - 1) < 1e-15) break
  }
  return front * h / a
}

/** Student-t distribution function, for the trend coefficient's p-value. */
export function pt(t: number, df: number): number {
  if (df <= 0) return Number.NaN
  const x = df / (df + t * t)
  const tail = 0.5 * incompleteBeta(df / 2, 0.5, x)
  return t > 0 ? 1 - tail : tail
}

/** Two-sided Student-t p-value. */
export function twoSidedT(t: number, df: number): number {
  return 2 * pt(-Math.abs(t), df)
}

/** Poisson distribution function, by summation. Used for the negative-binomial fallback. */
export function ppois(k: number, lambda: number): number {
  if (lambda <= 0) return k >= 0 ? 1 : 0
  const limit = Math.floor(k)
  if (limit < 0) return 0
  let term = Math.exp(-lambda)
  let sum = term
  for (let index = 1; index <= limit; index += 1) {
    term *= lambda / index
    sum += term
  }
  return Math.min(1, sum)
}

/** Smallest `k` with `P(X <= k) >= p` for a Poisson mean. */
export function qpois(p: number, lambda: number): number {
  if (lambda <= 0) return 0
  let k = 0
  let term = Math.exp(-lambda)
  let sum = term
  const cap = Math.ceil(lambda + 20 * Math.sqrt(lambda) + 50)
  while (sum < p && k < cap) {
    k += 1
    term *= lambda / k
    sum += term
  }
  return k
}

/**
 * Negative binomial distribution function in the `size`/`mu` parameterisation R uses.
 *
 * `P(X = k) = Gamma(k + size) / (Gamma(size) k!) * (size/(size+mu))^size * (mu/(size+mu))^k`
 */
export function pnbinom(k: number, size: number, mu: number): number {
  if (size <= 0 || mu <= 0) return k >= 0 ? 1 : 0
  const limit = Math.floor(k)
  if (limit < 0) return 0
  const probability = size / (size + mu)
  let term = Math.exp(size * Math.log(probability))
  let sum = term
  for (let index = 1; index <= limit; index += 1) {
    term *= (size + index - 1) / index * (1 - probability)
    sum += term
  }
  return Math.min(1, sum)
}

/** Smallest `k` with `P(X <= k) >= p` for a negative binomial. */
export function qnbinom(p: number, size: number, mu: number): number {
  if (size <= 0 || mu <= 0) return 0
  const probability = size / (size + mu)
  let k = 0
  let term = Math.exp(size * Math.log(probability))
  let sum = term
  const variance = mu + (mu * mu) / size
  const cap = Math.ceil(mu + 40 * Math.sqrt(variance) + 100)
  while (sum < p && k < cap) {
    k += 1
    term *= (size + k - 1) / k * (1 - probability)
    sum += term
  }
  return k
}
