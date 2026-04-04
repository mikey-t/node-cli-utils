import { Emoji, log, trace } from './generalUtils.js'
import { cyan } from './colors.js'

/**
 * A type guard useful for filtering results of `Promise.allSettled`.
 * @example
 * ```
 * const settledPromises = await Promise.allSettled(promises)
 * settledPromises.filter(isSettledRejected).map(r => r.reason)
 * ```
 */
export const isSettledRejected = (input: PromiseSettledResult<unknown>): input is PromiseRejectedResult => input.status === 'rejected'
/**
 * A type guard useful for filtering results of `Promise.allSettled`.
 * @example
 * ```
 * const settledPromises = await Promise.allSettled(promises)
 * settledPromises.filter(isSettledFulfilled).map(r => r.value)
 * ```
 */
export const isSettledFulfilled = <T>(input: PromiseSettledResult<T>): input is PromiseFulfilledResult<T> => input.status === 'fulfilled'

/**
 * The result from an individual operation during a call to {@link runParallel}.
 */
export interface ParallelItemResult<InputType, OutputType> {
  /** The original item passed to the operation function. */
  inputItem: InputType
  /** The result property will be undefined if the promise is rejected when operating on the item. */
  outputResult?: OutputType
  /** Set to `true` if not skipped, the promise wasn't rejected and the success evaluation function returned true for the output, `false` otherwise. */
  success: boolean
  /** The value of the promise rejection (often an Error object, but can technically be anything). */
  rejectedReason?: unknown
  /**
   * Items can be skipped if the {@link RunParallelOptions.shouldSkipFunc} is used and evaluated to `true` for an item, or if
   * {@link RunParallelOptions.onlyFirstN} was passed and the item was not in range.
   * */
  skipped: boolean
}

/**
 * The result of {@link runParallel}.
 */
export class ParallelResult<InputType, OutputType> {
  readonly allItemResults: ParallelItemResult<InputType, OutputType>[]
  readonly onlyFirstN?: number

  constructor(allItemResults: ParallelItemResult<InputType, OutputType>[], onlyFirstN?: number) {
    this.allItemResults = allItemResults
    this.onlyFirstN = onlyFirstN
  }

  get successfulItemResults(): ParallelItemResult<InputType, OutputType>[] {
    return this.allItemResults.filter(r => r.success)
  }
  get allInputItems(): InputType[] {
    return this.allItemResults.map(r => r.inputItem)
  }
  get allOutputResults(): OutputType[] {
    return this.allItemResults.filter(r => r.outputResult !== undefined).map(r => r.outputResult!)
  }
  /** Does not include skipped items. */
  get failedItemResults() {
    return this.allItemResults.filter(r => !r.success && !r.skipped)
  }
  get skippedItemResults() {
    return this.allItemResults.filter(r => r.skipped)
  }
  get rejectedItemResults() {
    return this.allItemResults.filter(r => r.rejectedReason)
  }
  get numSuccessful() {
    return this.successfulItemResults.length
  }
  /** Note that this does not include promise rejections (see {@link numRejected}) or skipped items (see {@link numSkipped}). */
  get numFailed() {
    return this.failedItemResults.length
  }
  /** Note that this does not include successful promises with failure results - see {@link numFailed}. */
  get numRejected() {
    return this.rejectedItemResults.length
  }
  get numSkipped() {
    return this.skippedItemResults.length
  }
  get numTotalItems() {
    return this.allItemResults.length
  }
  /** Does not consider skipped items - only promise rejections and evaluated failures. */
  get noFailures(): boolean {
    return this.numFailed === 0 && this.numRejected === 0
  }

  logFinishedMessage() {
    const divider = '---'
    const onlyFirstNMessage = this.onlyFirstN !== undefined ? ` (onlyFirstN set to ${this.onlyFirstN})` : ''

    log(`${this.noFailures ? Emoji.GreenCheck : Emoji.Warning} ${cyan('runParallel')} completed - ${this.numTotalItems - this.numSkipped} items processed${onlyFirstNMessage}`)

    if (this.numSkipped > 0) {
      log(`${Emoji.Info} skipped ${this.numSkipped}`)
    }

    if (this.numRejected > 0) {
      log(`${Emoji.Stop} Warning: some calls were rejected instead of returning a result`)
      log(divider)
      for (const rejected of this.rejectedItemResults) {
        log('item: ', rejected.inputItem)
        log('reason: ', rejected.rejectedReason)
        log(divider)
      }
    }

    if (this.numFailed > 0) {
      log(`${Emoji.Warning} Number of failed results: ${this.numFailed}`)
      log(divider)
      for (const failed of this.failedItemResults) {
        log('item: ', failed.inputItem)
        log('output: ', failed.outputResult)
        log(divider)
      }
    }
  }
}

/** The async function to run on each item during a call to {@link runParallel}. */
export type OperationExecutor<OutputType, InputType> = (operationItem: InputType) => Promise<OutputType>

/** The function that will determine whether each operation during a call to {@link runParallel} should be considered successful or not. */
export type SuccessChecker<OutputType> = (operationResult: OutputType) => boolean

/** The sync or async function that determines whether a particular item input for {@link runParallel} should be skipped or not. */
export type SkipChecker<InputType> = ((operationItem: InputType) => Promise<boolean>) | ((operationItem: InputType) => boolean)

/** Additional options that can be passed to {@link runParallel}. */
export interface RunParallelOptions<InputType> {
  /**
   * Defaults to 10 - the maximum number of tasks that will be allowed to run concurrently. While NodeJS is single-threaded,
   * it is worth controlling the number of running tasks to avoid overwhelming I/O or an external service.
   */
  maxConcurrent: number

  /** If provided, this will be used to determine whether or not an item should be skipped. */
  shouldSkipFunc?: SkipChecker<InputType>

  /**
   * If provided, this will limit processing to the first N items. Useful for testing new functionality on a subset of items.
   * 
   * Note that this will completely bypass any processing of items after the first N items. So for example, there won't be
   * "skipped" items for those not processed - they simply won't be on the result object at all.
   */
  onlyFirstN?: number
}

/**
 * Run an operation against an array of items.
 * @template OutputType The output type of each call to `operationFunc`.
 * @template InputType The input type for each item in the `itemsToOperateOn` array.
 * @param itemsToOperateOn The array of items of type `InputType` to operate on.
 * @param executorFunc The async function to call on each item in `itemsToOperateOn` - should return type `OutputType`.
 * @param isResultSuccessFunc The boolean returning function to evaluate whether each item of type `OutputType` returned should be considered successful.
 * @returns A {@link ParallelResult}
 */
export async function runParallel<InputType, OutputType>(itemsToOperateOn: Iterable<InputType>, executorFunc: OperationExecutor<OutputType, InputType>, isResultSuccessFunc: SuccessChecker<OutputType>, options?: Partial<RunParallelOptions<InputType>>): Promise<ParallelResult<InputType, OutputType>> {
  const defaultOptions: RunParallelOptions<InputType> = { maxConcurrent: 10 }
  const mergedOptions: RunParallelOptions<InputType> = { ...defaultOptions, ...options }

  const parallel = new ParallelExecutor<InputType, OutputType>(mergedOptions.maxConcurrent)
  const skippedItemResults: ParallelItemResult<InputType, OutputType>[] = []

  let i = 0
  for (const item of itemsToOperateOn) {
    if (mergedOptions.onlyFirstN !== undefined && i >= mergedOptions.onlyFirstN) {
      trace(`stopping because 'onlyFirstN' param was passed with the value ${mergedOptions.onlyFirstN}`)
      break
    }
    i++
    if (mergedOptions.shouldSkipFunc !== undefined && await mergedOptions.shouldSkipFunc(item)) {
      trace(`skipped item: `, item)
      skippedItemResults.push({ inputItem: item, skipped: true, success: false })
      continue
    }
    parallel.queueTask(item, executorFunc)
  }

  const promiseResults = await parallel.processQueue()
  const itemResults = promiseResults.filter(isSettledFulfilled).map(r => r.value)
  const promiseRejections = promiseResults.filter(isSettledRejected).map(r => r.reason)

  if (promiseRejections.length > 0) {
    log('---')
    log(`${Emoji.Exclamation} Warning: control flow functions that should normally not fail had promise rejections`)
    for (const reject of promiseRejections) {
      log(reject)
      log('---')
    }
  }

  for (const itemResult of itemResults) {
    itemResult.success = itemResult.rejectedReason === undefined
      && itemResult.outputResult !== undefined
      && isResultSuccessFunc(itemResult.outputResult)
  }

  const parallelResult = new ParallelResult([...itemResults, ...skippedItemResults], mergedOptions.onlyFirstN)

  return parallelResult
}

/** 
 * The return type of {@link ParallelExecutor.processQueue}. This is a generic wrapper for {@link Promise.allSettled} with results of type {@link ParallelItemResult}.
 * To filter the results, use type guards {@link isSettledRejected} and {@link isSettledFulfilled}.
*/
export type AllSettledResult<ParallelItemResult> = Promise<PromiseSettledResult<Awaited<ParallelItemResult>>[]>

/**
 * This class simulates a semaphore, running as many of the tasks simultaneously as possible while staying under the limit of the value passed for `maxConcurrent`.
 * 
 * Note that NodeJS is single-threaded, so this is more about prevention of overwhelming I/O systems and external services than it is about true parallel execution.
 */
export class ParallelExecutor<InputType, OutputType> {
  private maxConcurrent = 0
  private numExecuting = 0
  private queue: (() => void)[] = []
  private operationPromises: Promise<ParallelItemResult<InputType, OutputType>>[] = []
  private taskCompletePromises: Promise<void>[] = []

  constructor(maxConcurrent: number) {
    if (maxConcurrent <= 0) {
      throw new Error('Invalid value passed for maxConcurrent - must be greater than 0')
    }
    this.maxConcurrent = maxConcurrent
  }

  queueTask(item: InputType, operationFunc: OperationExecutor<OutputType, InputType>) {
    let completionResolver: () => void
    const completionPromise = new Promise<void>((resolve) => {
      completionResolver = resolve
    })
    this.taskCompletePromises.push(completionPromise)

    const operationWrapper = async (): Promise<ParallelItemResult<InputType, OutputType>> => {
      return new Promise(resolve => {
        operationFunc(item)
          .then(output => {
            resolve({
              inputItem: item,
              skipped: false,
              success: true, // Success status can later be re-evaluated based on the output
              rejectedReason: undefined,
              outputResult: output
            } as ParallelItemResult<InputType, OutputType>)
          })
          .catch(err => {
            resolve({
              inputItem: item,
              skipped: false,
              success: false,
              rejectedReason: err,
              outputResult: undefined
            } as ParallelItemResult<InputType, OutputType>)
          })
      })
    }

    const parallelTask = () => {
      trace(`Task called - queue.length: ${this.queue.length} - numExecuting: ${this.numExecuting}`)
      this.numExecuting++
      const promise = operationWrapper()
      this.operationPromises.push(promise)
      promise.finally(() => {
        this.release(completionResolver)
      })
    }

    this.queue.push(parallelTask)
  }

  async processQueue(): AllSettledResult<ParallelItemResult<InputType, OutputType>> {
    while (this.queue.length > 0 && this.numExecuting < this.maxConcurrent) {
      const next = this.queue.shift()
      if (next) next()
    }
    await Promise.allSettled(this.taskCompletePromises)
    return await Promise.allSettled(this.operationPromises)
  }

  private release(completionResolver: () => void) {
    trace(`Task released - queue.length: ${this.queue.length} - numExecuting: ${this.numExecuting}`)
    this.numExecuting--
    completionResolver()
    const next = this.queue.shift()
    if (next) next()
  }
}
