/**
 * Weighted quasi-Poisson regression, log link, by iteratively reweighted least squares.
 *
 * The one piece of machinery the Farrington family needs and nothing else here does. It is
 * written to match R's `glm(family = quasipoisson(link = "log"))` closely enough that
 * `farrington.ts` can be validated against the `surveillance` package: same starting values
 * (`mu = y + 0.1`), same convergence test on the relative change in deviance, same
 * dispersion estimator (Pearson chi-square over residual degrees of freedom, with prior
 * weights), and the same unscaled covariance `(X'WX)^-1` that R calls `cov.unscaled`.
 *
 * The design matrix is general rather than fixed at intercept-plus-trend. Farrington 1996
 * needs two columns; Noufaily 2013 replaces the anniversary window with a ten-level seasonal
 * factor and needs eleven. Building the general solver now costs a Gaussian elimination that
 * would otherwise be a 2×2 inverse, and means the seasonal variant is a change to how the
 * matrix is assembled rather than a second regression.
 */

export interface GlmFit {
  coefficients: number[]
  /** Fitted means on the response scale. */
  fitted: number[]
  /** Leverage, `h_i`, needed for the Anscombe residuals Farrington reweights on. */
  hat: number[]
  /** Pearson dispersion over residual degrees of freedom, before any flooring at 1. */
  dispersion: number
  /** `(X'WX)^-1`, R's `cov.unscaled`. Multiply by dispersion for the coefficient covariance. */
  covUnscaled: number[][]
  dfResidual: number
  deviance: number
  converged: boolean
}

/** Solve `A x = b` by Gaussian elimination with partial pivoting; `null` when singular. */
export function solve(matrix: readonly (readonly number[])[], vector: readonly number[]): number[] | null {
  const size = vector.length
  const a = matrix.map((row, index) => [...row, vector[index] as number])
  for (let column = 0; column < size; column += 1) {
    let pivot = column
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs((a[row] as number[])[column] as number) > Math.abs((a[pivot] as number[])[column] as number)) pivot = row
    }
    const pivotValue = (a[pivot] as number[])[column] as number
    if (!Number.isFinite(pivotValue) || Math.abs(pivotValue) < 1e-12) return null
    if (pivot !== column) {
      const held = a[pivot] as number[]
      a[pivot] = a[column] as number[]
      a[column] = held
    }
    const pivotRow = a[column] as number[]
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue
      const target = a[row] as number[]
      const factor = (target[column] as number) / (pivotRow[column] as number)
      if (factor === 0) continue
      for (let index = column; index <= size; index += 1) {
        target[index] = (target[index] as number) - factor * (pivotRow[index] as number)
      }
    }
  }
  return Array.from({ length: size }, (_, index) => {
    const row = a[index] as number[]
    return (row[size] as number) / (row[index] as number)
  })
}

/** Invert a small symmetric positive-definite matrix by solving against the identity. */
export function invert(matrix: readonly (readonly number[])[]): number[][] | null {
  const size = matrix.length
  const out: number[][] = []
  for (let column = 0; column < size; column += 1) {
    const unit = Array.from({ length: size }, (_, index) => (index === column ? 1 : 0))
    const solved = solve(matrix, unit)
    if (!solved) return null
    out.push(solved)
  }
  // `out` is built column by column; transpose so `out[i][j]` reads as row i, column j.
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => (out[column] as number[])[row] as number))
}

export interface GlmOptions {
  /** Prior weights. Defaults to one per observation. */
  weights?: readonly number[]
  maxIterations?: number
  tolerance?: number
}

/**
 * Fit `log(mu) = X beta` with quasi-Poisson variance.
 *
 * `design` has one row per observation, including the intercept column explicitly, so the
 * caller decides what is in the model.
 */
export function fitQuasiPoisson(
  response: readonly number[], design: readonly (readonly number[])[], options: GlmOptions = {}
): GlmFit | null {
  const n = response.length
  const p = design[0]?.length ?? 0
  if (n === 0 || p === 0 || design.length !== n) return null
  const priorWeights = options.weights ?? Array.from({ length: n }, () => 1)
  const maxIterations = options.maxIterations ?? 50
  const tolerance = options.tolerance ?? 1e-10

  // R's poisson `mustart`: `y + 0.1`, which keeps the log finite at a zero count.
  let mu = response.map((value) => value + 0.1)
  let eta = mu.map((value) => Math.log(value))
  let deviance = Number.POSITIVE_INFINITY
  let coefficients: number[] = Array.from({ length: p }, () => 0)
  let information: number[][] = []
  let converged = false

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    // Working response and weights for the log link with Poisson variance: the derivative
    // of the link cancels the variance function, leaving W = priorWeight * mu.
    const working = eta.map((value, index) =>
      value + ((response[index] as number) - (mu[index] as number)) / (mu[index] as number))
    const weight = mu.map((value, index) => (priorWeights[index] as number) * value)

    information = Array.from({ length: p }, () => Array.from({ length: p }, () => 0))
    const projection = Array.from({ length: p }, () => 0)
    for (let index = 0; index < n; index += 1) {
      const row = design[index] as readonly number[]
      const w = weight[index] as number
      for (let a = 0; a < p; a += 1) {
        const rowA = (row[a] as number) * w
        projection[a] = (projection[a] as number) + rowA * (working[index] as number)
        for (let b = 0; b < p; b += 1) {
          (information[a] as number[])[b] = ((information[a] as number[])[b] as number) + rowA * (row[b] as number)
        }
      }
    }
    const solved = solve(information, projection)
    if (!solved) return null
    coefficients = solved

    eta = design.map((row) => row.reduce((sum, value, index) => sum + value * (coefficients[index] as number), 0))
    mu = eta.map((value) => Math.exp(value))
    if (mu.some((value) => !Number.isFinite(value) || value <= 0)) return null

    let updated = 0
    for (let index = 0; index < n; index += 1) {
      const y = response[index] as number
      const m = mu[index] as number
      const term = y > 0 ? y * Math.log(y / m) : 0
      updated += 2 * (priorWeights[index] as number) * (term - (y - m))
    }
    if (Math.abs(updated - deviance) / (Math.abs(updated) + 0.1) < tolerance) {
      deviance = updated
      converged = true
      break
    }
    deviance = updated
  }

  const covUnscaled = invert(information)
  if (!covUnscaled) return null

  const dfResidual = n - p
  let pearson = 0
  for (let index = 0; index < n; index += 1) {
    const residual = (response[index] as number) - (mu[index] as number)
    pearson += (priorWeights[index] as number) * residual * residual / (mu[index] as number)
  }
  const dispersion = dfResidual > 0 ? pearson / dfResidual : Number.NaN

  // h_i = W_i * x_i' (X'WX)^-1 x_i, the diagonal of the hat matrix on the working scale.
  const hat = design.map((row, index) => {
    const w = (priorWeights[index] as number) * (mu[index] as number)
    let value = 0
    for (let a = 0; a < p; a += 1) {
      for (let b = 0; b < p; b += 1) {
        value += (row[a] as number) * ((covUnscaled[a] as number[])[b] as number) * (row[b] as number)
      }
    }
    return w * value
  })

  return { coefficients, fitted: mu, hat, dispersion, covUnscaled, dfResidual, deviance, converged }
}

/** Standard error of the linear predictor at one design row, given a dispersion. */
export function predictStandardError(
  fit: GlmFit, row: readonly number[], dispersion: number
): number {
  let value = 0
  for (let a = 0; a < row.length; a += 1) {
    for (let b = 0; b < row.length; b += 1) {
      value += (row[a] as number) * ((fit.covUnscaled[a] as number[])[b] as number) * (row[b] as number)
    }
  }
  return Math.sqrt(Math.max(0, dispersion * value))
}
