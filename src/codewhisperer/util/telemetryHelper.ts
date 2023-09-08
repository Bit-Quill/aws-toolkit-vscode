/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import globals from '../../shared/extensionGlobals'

import { runtimeLanguageContext } from './runtimeLanguageContext'
import { codeWhispererClient as client, RecommendationsList } from '../client/codewhisperer'
import { LicenseUtil } from './licenseUtil'
import {
    CodewhispererLanguage,
    CodewhispererPreviousSuggestionState,
    CodewhispererServiceInvocation,
    CodewhispererUserDecision,
    CodewhispererUserTriggerDecision,
    telemetry,
} from '../../shared/telemetry/telemetry'
import {
    CodewhispererAutomatedTriggerType,
    CodewhispererCompletionType,
    CodewhispererSuggestionState,
    CodewhispererTriggerType,
} from '../../shared/telemetry/telemetry'
import { getImportCount } from './importAdderUtil'
import { CodeWhispererSettings } from './codewhispererSettings'
import { CodeWhispererUserGroupSettings } from './userGroupUtil'
import { CodeWhispererSupplementalContext } from './supplementalContext/supplementalContextUtil'
import { AuthUtil } from './authUtil'
import { isAwsError } from '../../shared/errors'
import { getLogger } from '../../shared/logger'
import { session } from './codeWhispererSession'

const performance = globalThis.performance ?? require('perf_hooks').performance

export class TelemetryHelper {
    /**
     * Trigger type for getting CodeWhisperer recommendation
     */
    public triggerType: CodewhispererTriggerType
    /**
     * Auto Trigger Type for getting event of Automated Trigger
     */
    public CodeWhispererAutomatedtriggerType: CodewhispererAutomatedTriggerType
    /**
     * the cursor offset location at invocation time
     */
    public cursorOffset: number

    // Some variables for client component latency
    private sdkApiCallEndTime = 0
    private firstSuggestionShowTime = 0
    private allPaginationEndTime = 0
    private firstResponseRequestId = ''
    // variables for user trigger decision
    // these will be cleared after a invocation session
    private sessionDecisions: CodewhispererUserTriggerDecision[] = []
    public sessionInvocations: CodewhispererServiceInvocation[] = []
    private triggerChar?: string = undefined
    private prevTriggerDecision?: CodewhispererPreviousSuggestionState
    private isRequestCancelled = false
    private lastRequestId = ''
    private numberOfRequests = 0
    private typeAheadLength = 0
    private timeSinceLastModification = 0
    private lastTriggerDecisionTime = 0
    private invocationTime = 0
    private timeToFirstRecommendation = 0
    private classifierResult?: number = undefined
    private classifierThreshold?: number = undefined
    private suggestionReferenceNumber = 0
    private generatedLines = 0

    constructor() {
        this.triggerType = 'OnDemand'
        this.CodeWhispererAutomatedtriggerType = 'KeyStrokeCount'
        this.cursorOffset = 0
    }

    static #instance: TelemetryHelper

    public static get instance() {
        return (this.#instance ??= new this())
    }

    public recordServiceInvocationTelemetry(
        requestId: string,
        sessionId: string,
        lastSuggestionIndex: number,
        triggerType: CodewhispererTriggerType,
        autoTriggerType: CodewhispererAutomatedTriggerType | undefined,
        result: 'Succeeded' | 'Failed',
        duration: number | undefined,
        lineNumber: number | undefined,
        language: CodewhispererLanguage,
        reason: string,
        supplementalContextMetadata?: Omit<CodeWhispererSupplementalContext, 'supplementalContextItems'> | undefined
    ) {
        const event = {
            codewhispererRequestId: requestId ? requestId : undefined,
            codewhispererSessionId: sessionId ? sessionId : undefined,
            codewhispererLastSuggestionIndex: lastSuggestionIndex,
            codewhispererTriggerType: triggerType,
            codewhispererAutomatedTriggerType: autoTriggerType,
            result,
            duration: duration || 0,
            codewhispererLineNumber: lineNumber || 0,
            codewhispererCursorOffset: this.cursorOffset || 0,
            codewhispererLanguage: language,
            reason: reason ? reason.substring(0, 200) : undefined,
            credentialStartUrl: AuthUtil.instance.startUrl,
            codewhispererImportRecommendationEnabled: CodeWhispererSettings.instance.isImportRecommendationEnabled(),
            codewhispererSupplementalContextTimeout: supplementalContextMetadata?.isProcessTimeout,
            codewhispererSupplementalContextIsUtg: supplementalContextMetadata?.isUtg,
            codewhispererSupplementalContextLatency: supplementalContextMetadata?.latency,
            codewhispererSupplementalContextLength: supplementalContextMetadata?.contentsLength,
            codewhispererUserGroup: CodeWhispererUserGroupSettings.getUserGroup().toString(),
        }
        telemetry.codewhisperer_serviceInvocation.emit(event)
        this.sessionInvocations.push(event)
    }

    public recordUserDecisionTelemetryForEmptyList(
        requestId: string,
        sessionId: string,
        paginationIndex: number,
        languageId: string,
        supplementalContextMetadata?: Omit<CodeWhispererSupplementalContext, 'supplementalContextItems'> | undefined
    ) {
        const languageContext = runtimeLanguageContext.getLanguageContext(languageId)
        telemetry.codewhisperer_userDecision.emit({
            codewhispererRequestId: requestId,
            codewhispererSessionId: sessionId ? sessionId : undefined,
            codewhispererPaginationProgress: paginationIndex,
            codewhispererTriggerType: this.triggerType,
            codewhispererSuggestionIndex: -1,
            codewhispererSuggestionState: 'Empty',
            codewhispererSuggestionReferences: undefined,
            codewhispererSuggestionReferenceCount: 0,
            codewhispererCompletionType: 'Line',
            codewhispererLanguage: languageContext.language,
            credentialStartUrl: AuthUtil.instance.startUrl,
            codewhispererUserGroup: CodeWhispererUserGroupSettings.getUserGroup().toString(),
            codewhispererSupplementalContextTimeout: supplementalContextMetadata?.isProcessTimeout,
            codewhispererSupplementalContextIsUtg: supplementalContextMetadata?.isUtg,
            codewhispererSupplementalContextLength: supplementalContextMetadata?.contentsLength,
        })
    }

    /**
     * This function is to record the user decision on each of the suggestion in the list of CodeWhisperer recommendations.
     * @param recommendations the recommendations
     * @param acceptIndex the index of the accepted suggestion in the corresponding list of CodeWhisperer response.
     * If this function is not called on acceptance, then acceptIndex == -1
     * @param languageId the language ID of the current document in current active editor
     * @param paginationIndex the index of pagination calls
     * @param recommendationSuggestionState the key-value mapping from index to suggestion state
     */

    public recordUserDecisionTelemetry(
        requestId: string,
        sessionId: string,
        recommendations: RecommendationsList,
        acceptIndex: number,
        languageId: string | undefined,
        paginationIndex: number,
        completionTypes: Map<number, CodewhispererCompletionType>,
        recommendationSuggestionState?: Map<number, string>,
        supplementalContextMetadata?: Omit<CodeWhispererSupplementalContext, 'supplementalContextItems'> | undefined
    ) {
        const languageContext = runtimeLanguageContext.getLanguageContext(languageId)
        const events: CodewhispererUserDecision[] = []
        // emit user decision telemetry
        recommendations.forEach((_elem, i) => {
            let uniqueSuggestionReferences: string | undefined = undefined
            const uniqueLicenseSet = LicenseUtil.getUniqueLicenseNames(_elem.references)
            if (uniqueLicenseSet.size > 0) {
                uniqueSuggestionReferences = JSON.stringify(Array.from(uniqueLicenseSet))
            }
            if (_elem.content.length === 0) {
                recommendationSuggestionState?.set(i, 'Empty')
            }
            const event: CodewhispererUserDecision = {
                codewhispererRequestId: requestId,
                codewhispererSessionId: sessionId ? sessionId : undefined,
                codewhispererPaginationProgress: paginationIndex,
                codewhispererTriggerType: this.triggerType,
                codewhispererSuggestionIndex: i,
                codewhispererSuggestionState: this.getSuggestionState(i, acceptIndex, recommendationSuggestionState),
                codewhispererSuggestionReferences: uniqueSuggestionReferences,
                codewhispererSuggestionReferenceCount: _elem.references ? _elem.references.length : 0,
                codewhispererSuggestionImportCount: getImportCount(_elem),
                codewhispererCompletionType: this.getCompletionType(i, completionTypes),
                codewhispererLanguage: languageContext.language,
                credentialStartUrl: AuthUtil.instance.startUrl,
                codewhispererUserGroup: CodeWhispererUserGroupSettings.getUserGroup().toString(),
                codewhispererSupplementalContextTimeout: supplementalContextMetadata?.isProcessTimeout,
                codewhispererSupplementalContextIsUtg: supplementalContextMetadata?.isUtg,
                codewhispererSupplementalContextLength: supplementalContextMetadata?.contentsLength,
            }
            telemetry.codewhisperer_userDecision.emit(event)
            events.push(event)
        })

        //aggregate suggestion references count
        this.getAggregatedSuggestionReferenceCount(events)

        // aggregate user decision events at requestId level
        const aggregatedEvent = this.aggregateUserDecisionByRequest(events, requestId, sessionId)
        if (aggregatedEvent) {
            this.sessionDecisions.push(aggregatedEvent)
        }

        // TODO: use a ternary for this
        let acceptedRecommendationContent
        if (acceptIndex != -1 && recommendations[acceptIndex] != undefined) {
            acceptedRecommendationContent = recommendations[acceptIndex].content
        } else {
            acceptedRecommendationContent = ''
        }

        // after we have all request level user decisions, aggregate them at session level and send
        if (
            this.isRequestCancelled ||
            (this.lastRequestId && this.lastRequestId === requestId) ||
            (this.sessionDecisions.length && this.sessionDecisions.length === this.numberOfRequests)
        ) {
            this.sendUserTriggerDecisionTelemetry(sessionId, acceptedRecommendationContent, supplementalContextMetadata)
        }
    }

    public aggregateUserDecisionByRequest(
        events: CodewhispererUserDecision[],
        requestId: string,
        sessionId: string,
        supplementalContextMetadata?: Omit<CodeWhispererSupplementalContext, 'contents'> | undefined
    ) {
        // the request level user decision will contain information from both the service_invocation event
        // and the user_decision events for recommendations within that request
        const serviceInvocation = this.sessionInvocations.find(e => e.codewhispererRequestId === requestId)
        if (!serviceInvocation || !events.length) {
            return
        }
        const aggregated: CodewhispererUserTriggerDecision = {
            codewhispererSessionId: sessionId,
            codewhispererFirstRequestId: this.sessionInvocations[0].codewhispererRequestId ?? requestId,
            credentialStartUrl: events[0].credentialStartUrl,
            codewhispererCompletionType: this.getAggregatedCompletionType(events),
            codewhispererLanguage: events[0].codewhispererLanguage,
            codewhispererTriggerType: events[0].codewhispererTriggerType,
            codewhispererSuggestionCount: events.length,
            codewhispererAutomatedTriggerType: serviceInvocation.codewhispererAutomatedTriggerType,
            codewhispererLineNumber: serviceInvocation.codewhispererLineNumber,
            codewhispererCursorOffset: serviceInvocation.codewhispererCursorOffset,
            codewhispererSuggestionState: this.getAggregatedSuggestionState(events),
            codewhispererSuggestionImportCount: events
                .map(e => e.codewhispererSuggestionImportCount || 0)
                .reduce((a, b) => a + b, 0),
            codewhispererTypeaheadLength: 0,
            codewhispererUserGroup: CodeWhispererUserGroupSettings.getUserGroup().toString(),
            codewhispererSupplementalContextTimeout: supplementalContextMetadata?.isProcessTimeout,
            codewhispererSupplementalContextIsUtg: supplementalContextMetadata?.isUtg,
            codewhispererSupplementalContextLength: supplementalContextMetadata?.contentsLength,
        }
        return aggregated
    }

    public sendUserTriggerDecisionTelemetry(
        sessionId: string,
        acceptedRecommendationContent: string,
        supplementalContextMetadata?: Omit<CodeWhispererSupplementalContext, 'supplementalContextItems'> | undefined
    ) {
        // the user trigger decision will aggregate information from request level user decisions within one session
        // and add additional session level insights
        if (!this.sessionDecisions.length) {
            return
        }

        // TODO: add partial acceptance related metrics
        const autoTriggerType = this.sessionDecisions[0].codewhispererAutomatedTriggerType
        const language = this.sessionDecisions[0].codewhispererLanguage
        const aggregatedCompletionType = this.getAggregatedCompletionType(this.sessionDecisions)
        const aggregatedSuggestionState = this.getAggregatedSuggestionState(this.sessionDecisions)
        const aggregated: CodewhispererUserTriggerDecision = {
            codewhispererSessionId: this.sessionDecisions[0].codewhispererSessionId,
            codewhispererFirstRequestId: this.sessionDecisions[0].codewhispererFirstRequestId,
            credentialStartUrl: this.sessionDecisions[0].credentialStartUrl,
            codewhispererCompletionType: aggregatedCompletionType,
            codewhispererLanguage: language,
            codewhispererTriggerType: this.sessionDecisions[0].codewhispererTriggerType,
            codewhispererSuggestionCount: this.sessionDecisions
                .map(e => e.codewhispererSuggestionCount)
                .reduce((a, b) => a + b, 0),
            codewhispererAutomatedTriggerType: autoTriggerType,
            codewhispererLineNumber: this.sessionDecisions[0].codewhispererLineNumber,
            codewhispererCursorOffset: this.sessionDecisions[0].codewhispererCursorOffset,
            codewhispererSuggestionImportCount: this.sessionDecisions
                .map(e => e.codewhispererSuggestionImportCount || 0)
                .reduce((a, b) => a + b, 0),
            codewhispererTypeaheadLength: this.typeAheadLength,
            codewhispererTimeSinceLastDocumentChange: this.timeSinceLastModification
                ? this.timeSinceLastModification
                : undefined,
            codewhispererTimeSinceLastUserDecision: this.lastTriggerDecisionTime
                ? performance.now() - this.lastTriggerDecisionTime
                : undefined,
            codewhispererTimeToFirstRecommendation: this.timeToFirstRecommendation,
            codewhispererTriggerCharacter: autoTriggerType === 'SpecialCharacters' ? this.triggerChar : undefined,
            codewhispererSuggestionState: aggregatedSuggestionState,
            codewhispererPreviousSuggestionState: this.prevTriggerDecision,
            codewhispererClassifierResult: this.classifierResult,
            codewhispererClassifierThreshold: this.classifierThreshold,
            codewhispererUserGroup: CodeWhispererUserGroupSettings.getUserGroup().toString(),
            codewhispererSupplementalContextTimeout: supplementalContextMetadata?.isProcessTimeout,
            codewhispererSupplementalContextIsUtg: supplementalContextMetadata?.isUtg,
            codewhispererSupplementalContextLength: supplementalContextMetadata?.contentsLength,
        }
        telemetry.codewhisperer_userTriggerDecision.emit(aggregated)
        this.prevTriggerDecision = this.getAggregatedSuggestionState(this.sessionDecisions)
        this.lastTriggerDecisionTime = performance.now()

        // When we send a userTriggerDecision of Empty or Discard, we set the time users see the first
        // suggestion to be now.
        let e2eLatency = this.firstSuggestionShowTime - session.invokeSuggestionStartTime
        if (e2eLatency < 0) {
            e2eLatency = performance.now() - session.invokeSuggestionStartTime
        }
        client
            .sendTelemetryEvent({
                telemetryEvent: {
                    userTriggerDecisionEvent: {
                        sessionId: sessionId,
                        requestId: this.sessionDecisions[0].codewhispererFirstRequestId,
                        programmingLanguage: {
                            languageName: this.sessionDecisions[0].codewhispererLanguage,
                        },
                        completionType: this.getSendTelemetryCompletionType(aggregatedCompletionType),
                        suggestionState: this.getSendTelemetrySuggestionState(aggregatedSuggestionState),
                        recommendationLatencyMilliseconds: e2eLatency,
                        timestamp: new Date(Date.now()),
                        suggestionReferenceCount: this.suggestionReferenceNumber,
                        generatedLine: this.generatedLines,
                    },
                },
            })
            .then()
            .catch(error => {
                let requestId: string | undefined
                if (isAwsError(error)) {
                    requestId = error.requestId
                }

                getLogger().debug(
                    `Failed to sendTelemetryEvent to CodeWhisperer, requestId: ${requestId ?? ''}, message: ${
                        error.message
                    }`
                )
            })
        this.resetUserTriggerDecisionTelemetry()
    }

    public getLastTriggerDecisionForClassifier() {
        if (this.lastTriggerDecisionTime && Date.now() - this.lastTriggerDecisionTime <= 2 * 60 * 1000) {
            return this.prevTriggerDecision
        }
    }

    public setClassifierResult(classifierResult: number) {
        this.classifierResult = classifierResult
    }

    public setClassifierThreshold(classifierThreshold: number) {
        this.classifierThreshold = classifierThreshold
    }

    public setIsRequestCancelled(isRequestCancelled: boolean) {
        this.isRequestCancelled = isRequestCancelled
    }

    public setTriggerCharForUserTriggerDecision(triggerChar: string) {
        this.triggerChar = triggerChar
    }

    public setLastRequestId(requestId: string) {
        this.lastRequestId = requestId
    }

    public setNumberOfRequestsInSession(numberOfRequests: number) {
        this.numberOfRequests = numberOfRequests
    }

    public setTypeAheadLength(typeAheadLength: number) {
        this.typeAheadLength = typeAheadLength
    }

    public setTimeSinceLastModification(timeSinceLastModification: number) {
        this.timeSinceLastModification = timeSinceLastModification
    }

    public setInvocationStartTime(invocationTime: number) {
        this.invocationTime = invocationTime
    }

    public setTimeToFirstRecommendation(timeToFirstRecommendation: number) {
        if (this.invocationTime) {
            this.timeToFirstRecommendation = timeToFirstRecommendation - this.invocationTime
        }
    }

    private resetUserTriggerDecisionTelemetry() {
        this.sessionDecisions = []
        this.isRequestCancelled = false
        this.sessionInvocations = []
        this.triggerChar = ''
        this.lastRequestId = ''
        this.numberOfRequests = 0
        this.typeAheadLength = 0
        this.timeSinceLastModification = 0
        this.timeToFirstRecommendation = 0
        this.classifierResult = undefined
        this.classifierThreshold = undefined
    }

    private getAggregatedCompletionType(
        // if there is any Block completion within the session, mark the session as Block completion
        events: CodewhispererUserDecision[] | CodewhispererUserTriggerDecision[]
    ): CodewhispererCompletionType {
        return events.some(e => e.codewhispererCompletionType === 'Block') ? 'Block' : 'Line'
    }

    private getSendTelemetryCompletionType(completionType: CodewhispererCompletionType) {
        return completionType === 'Block' ? 'BLOCK' : 'LINE'
    }

    private getAggregatedSuggestionState(
        // if there is any Accept within the session, mark the session as Accept
        // if there is any Reject within the session, mark the session as Reject
        // if all recommendations within the session are empty, mark the session as Empty
        // otherwise mark the session as Discard
        events: CodewhispererUserDecision[] | CodewhispererUserTriggerDecision[]
    ): CodewhispererPreviousSuggestionState {
        let isEmpty = true
        for (const event of events) {
            if (event.codewhispererSuggestionState === 'Accept') {
                return 'Accept'
            } else if (event.codewhispererSuggestionState === 'Reject') {
                return 'Reject'
            } else if (event.codewhispererSuggestionState !== 'Empty') {
                isEmpty = false
            }
        }
        return isEmpty ? 'Empty' : 'Discard'
    }

    private getSendTelemetrySuggestionState(state: CodewhispererPreviousSuggestionState) {
        if (state === 'Accept') {
            return 'ACCEPT'
        } else if (state === 'Reject') {
            return 'REJECT'
        } else if (state === 'Discard') {
            return 'DISCARD'
        }
        return 'EMPTY'
    }

    private getAggregatedSuggestionReferenceCount(
        events: CodewhispererUserDecision[]
        // if there is any recommendation reference within the session, mark the reference number
        // as 1, otherwise mark the session as 0
    ) {
        for (const event of events) {
            if (event.codewhispererSuggestionReferenceCount != 0) {
                this.suggestionReferenceNumber = 1
                return
            }
        }
    }

    public getSuggestionState(
        i: number,
        acceptIndex: number,
        recommendationSuggestionState?: Map<number, string>
    ): CodewhispererSuggestionState {
        const state = recommendationSuggestionState?.get(i)
        if (state && ['Empty', 'Filter', 'Discard'].includes(state)) {
            return state as CodewhispererSuggestionState
        } else if (recommendationSuggestionState !== undefined && recommendationSuggestionState.get(i) !== 'Showed') {
            return 'Unseen'
        }
        if (acceptIndex === -1) {
            return 'Reject'
        }
        return i === acceptIndex ? 'Accept' : 'Ignore'
    }

    public getCompletionType(i: number, completionTypes: Map<number, CodewhispererCompletionType>) {
        return completionTypes.get(i) || 'Line'
    }

    public isTelemetryEnabled(): boolean {
        return globals.telemetry.telemetryEnabled
    }

    public resetClientComponentLatencyTime() {
        session.invokeSuggestionStartTime = 0
        session.sdkApiCallStartTime = 0
        this.sdkApiCallEndTime = 0
        session.fetchCredentialStartTime = 0
        this.firstSuggestionShowTime = 0
        this.allPaginationEndTime = 0
        this.firstResponseRequestId = ''
    }

    /** This method is assumed to be invoked first at the start of execution **/
    public setInvokeSuggestionStartTime() {
        this.resetClientComponentLatencyTime()
        session.invokeSuggestionStartTime = performance.now()
    }

    public setSdkApiCallEndTime() {
        if (this.sdkApiCallEndTime === 0 && session.sdkApiCallStartTime !== 0) {
            this.sdkApiCallEndTime = performance.now()
        }
    }

    public setAllPaginationEndTime() {
        if (this.allPaginationEndTime === 0 && this.sdkApiCallEndTime !== 0) {
            this.allPaginationEndTime = performance.now()
        }
    }

    public setFirstSuggestionShowTime() {
        if (this.firstSuggestionShowTime === 0 && this.sdkApiCallEndTime !== 0) {
            this.firstSuggestionShowTime = performance.now()
        }
    }

    public setFirstResponseRequestId(requestId: string) {
        if (this.firstResponseRequestId === '') {
            this.firstResponseRequestId = requestId
        }
    }

    // report client component latency after all pagination call finish
    // and at least one suggestion is shown to the user
    public tryRecordClientComponentLatency(languageId: string) {
        if (this.firstSuggestionShowTime === 0 || this.allPaginationEndTime === 0) {
            return
        }
        telemetry.codewhisperer_clientComponentLatency.emit({
            codewhispererRequestId: this.firstResponseRequestId,
            codewhispererSessionId: session.sessionId,
            codewhispererFirstCompletionLatency: this.sdkApiCallEndTime - session.sdkApiCallStartTime,
            codewhispererEndToEndLatency: this.firstSuggestionShowTime - session.invokeSuggestionStartTime,
            codewhispererAllCompletionsLatency: this.allPaginationEndTime - session.sdkApiCallStartTime,
            codewhispererPostprocessingLatency: this.firstSuggestionShowTime - this.sdkApiCallEndTime,
            codewhispererCredentialFetchingLatency: session.sdkApiCallStartTime - session.fetchCredentialStartTime,
            codewhispererPreprocessingLatency: session.fetchCredentialStartTime - session.invokeSuggestionStartTime,
            codewhispererCompletionType: 'Line',
            codewhispererTriggerType: this.triggerType,
            codewhispererLanguage: runtimeLanguageContext.getLanguageContext(languageId).language,
            credentialStartUrl: AuthUtil.instance.startUrl,
            codewhispererUserGroup: CodeWhispererUserGroupSettings.getUserGroup().toString(),
        })
    }
    public sendCodeScanEvent(languageId: string, jobId: string) {
        getLogger().debug(`start sendCodeScanEvent: jobId: "${jobId}", languageId: "${languageId}"`)
        client
            .sendTelemetryEvent({
                telemetryEvent: {
                    codeScanEvent: {
                        programmingLanguage: {
                            languageName: languageId,
                        },
                        codeScanJobId: jobId,
                        timestamp: new Date(Date.now()),
                    },
                },
            })
            .then()
            .catch(error => {
                let requestId: string | undefined
                if (isAwsError(error)) {
                    requestId = error.requestId
                }

                getLogger().debug(
                    `Failed to sendCodeScanEvent to CodeWhisperer, requestId: ${requestId ?? ''}, message: ${
                        error.message
                    }`
                )
            })
    }
}
