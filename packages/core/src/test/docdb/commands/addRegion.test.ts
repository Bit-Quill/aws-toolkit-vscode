/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import * as sinon from 'sinon'
import * as vscode from 'vscode'
import { assertTelemetry } from '../../testUtil'
import { getTestWindow } from '../../shared/vscode/window'
import { globals } from '../../../shared'
import { DBStorageType, DefaultDocumentDBClient, DocumentDBClient } from '../../../shared/clients/docdbClient'
import { addRegion } from '../../../docdb/commands/addRegion'
import { DBClusterNode } from '../../../docdb/explorer/dbClusterNode'
import { DocumentDBNode } from '../../../docdb/explorer/docdbNode'

describe('addRegionCommand', function () {
    const globalClusterName = 'docdb-global'
    const clusterName = 'docdb-1234'
    const cluster = {
        DBClusterArn: 'arn:docdb-1234',
        Status: 'available',
    }
    let docdb: DocumentDBClient
    let node: DBClusterNode
    let sandbox: sinon.SinonSandbox
    let spyExecuteCommand: sinon.SinonSpy

    beforeEach(function () {
        sandbox = sinon.createSandbox()
        spyExecuteCommand = sandbox.spy(vscode.commands, 'executeCommand')
        sandbox.stub(globals.regionProvider, 'isServiceInRegion').returns(true)
        sandbox.stub(globals.regionProvider, 'getRegions').returns([
            { id: 'us-test-1', name: 'Test Region 1' },
            { id: 'us-test-2', name: 'Test Region 2' },
        ])

        docdb = { regionCode: 'us-test-1' } as DocumentDBClient
        docdb.listEngineVersions = sinon.stub().resolves([{ EngineVersion: 'test-version' }])
        docdb.listInstanceClassOptions = sinon
            .stub()
            .resolves([{ DBInstanceClass: 'db.r5.large', StorageType: DBStorageType.Standard }])

        sandbox.stub(DefaultDocumentDBClient, 'create').returns(docdb)

        const parentNode = new DocumentDBNode(docdb)
        node = new DBClusterNode(parentNode, cluster, docdb)
    })

    afterEach(function () {
        sandbox.restore()
        getTestWindow().dispose()
    })

    function setupWizard() {
        getTestWindow().onDidShowInputBox((input) => {
            let value: string
            if (input.prompt?.includes('global')) {
                value = globalClusterName
            } else if (input.prompt?.includes('cluster name')) {
                value = clusterName
            } else {
                value = ''
            }
            input.acceptValue(value)
        })

        getTestWindow().onDidShowQuickPick(async (picker) => {
            await picker.untilReady()
            picker.acceptItem(picker.items[0])
        })
    }

    it('prompts for new region and cluster params, creates cluster, shows success, and refreshes node', async function () {
        // arrange
        const createGlobalClusterStub = sinon.stub().resolves({
            GlobalClusterIdentifier: globalClusterName,
        })
        const createClusterStub = sinon.stub().resolves({
            DBClusterIdentifier: clusterName,
        })
        const createInstanceStub = sinon.stub().resolves()
        docdb.createGlobalCluster = createGlobalClusterStub
        docdb.createCluster = createClusterStub
        docdb.createInstance = createInstanceStub
        setupWizard()

        // act
        await addRegion(node)

        // assert
        getTestWindow().getFirstMessage().assertInfo('Region added')

        assert(
            createGlobalClusterStub.calledOnceWithExactly({
                GlobalClusterIdentifier: globalClusterName,
                SourceDBClusterIdentifier: cluster.DBClusterArn,
            })
        )

        assert(
            createClusterStub.calledOnceWith(
                sinon.match({
                    DBClusterIdentifier: clusterName,
                    GlobalClusterIdentifier: globalClusterName,
                })
            )
        )

        assert(
            createInstanceStub.calledOnceWith(
                sinon.match({
                    Engine: 'docdb',
                    DBClusterIdentifier: clusterName,
                    DBInstanceIdentifier: clusterName,
                    DBInstanceClass: 'db.r5.large',
                })
            )
        )

        sandbox.assert.calledWith(spyExecuteCommand, 'aws.refreshAwsExplorerNode', node.parent)

        assertTelemetry('docdb_addRegion', { result: 'Succeeded' })
    })

    it('does nothing when prompt is cancelled', async function () {
        // arrange
        const stub = sinon.stub()
        docdb.createGlobalCluster = stub
        getTestWindow().onDidShowQuickPick((input) => input.hide())

        // act
        await assert.rejects(addRegion(node))

        // assert
        assert(stub.notCalled)

        assertTelemetry('docdb_addRegion', { result: 'Cancelled' })
    })

    it('shows an error when cluster creation fails', async function () {
        // arrange
        docdb.createGlobalCluster = sinon.stub().resolves({
            GlobalClusterIdentifier: globalClusterName,
        })
        docdb.createCluster = sinon.stub().rejects()
        setupWizard()

        // act
        await assert.rejects(addRegion(node))

        // assert
        getTestWindow()
            .getFirstMessage()
            .assertError(/Failed to create cluster: docdb-1234/)

        assertTelemetry('docdb_addRegion', { result: 'Failed' })
    })
})
