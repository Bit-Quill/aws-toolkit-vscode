/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import * as sinon from 'sinon'
import * as vscode from 'vscode'
import { getTestWindow } from '../../shared/vscode/window'
import { DocumentDBNode } from '../../../docdb/explorer/docdbNode'
import { DBStorageType, DocumentDBClient } from '../../../shared/clients/docdbClient'
import { createCluster } from '../../../docdb/commands/createCluster'

describe('createClusterCommand', function () {
    const clusterName = 'docdb-1234'
    const username = 'testuser'
    const password = 'test-password'
    let docdb: DocumentDBClient
    let node: DocumentDBNode
    let sandbox: sinon.SinonSandbox
    let spyExecuteCommand: sinon.SinonSpy

    beforeEach(function () {
        sandbox = sinon.createSandbox()
        spyExecuteCommand = sandbox.spy(vscode.commands, 'executeCommand')

        docdb = { regionCode: 'us-east-1' } as DocumentDBClient
        docdb.listEngineVersions = sinon.stub().resolves([{ EngineVersion: 'test-version' }])
        docdb.listInstanceClassOptions = sinon
            .stub()
            .resolves([{ DBInstanceClass: 'db.t3.medium', StorageType: DBStorageType.Standard }])

        node = new DocumentDBNode(docdb)
    })

    afterEach(function () {
        sandbox.restore()
        getTestWindow().dispose()
    })

    function setupWizard() {
        getTestWindow().onDidShowInputBox((input) => {
            let value: string
            switch (input.step) {
                case 1:
                    value = clusterName
                    break
                case 3:
                    value = username
                    break
                case 4:
                    value = password
                    break
                default:
                    value = ''
                    break
            }
            input.acceptValue(value)
        })

        getTestWindow().onDidShowQuickPick(async (picker) => {
            await picker.untilReady()
            picker.acceptItem(picker.items[0])
        })
    }

    it('prompts for cluster params, creates cluster, shows success, and refreshes node', async function () {
        // arrange
        const createClusterStub = sinon.stub().resolves({
            DBClusterIdentifier: clusterName,
        })
        const createInstanceStub = sinon.stub().resolves({
            DBInstanceIdentifier: clusterName,
        })
        docdb.createCluster = createClusterStub
        docdb.createInstance = createInstanceStub
        setupWizard()

        // act
        await createCluster(node)

        // assert
        getTestWindow()
            .getFirstMessage()
            .assertInfo(/Created cluster: docdb-1234/)

        assert(
            createClusterStub.calledOnceWithExactly({
                Engine: 'docdb',
                EngineVersion: 'test-version',
                DBClusterIdentifier: clusterName,
                MasterUsername: username,
                MasterUserPassword: password,
                StorageEncrypted: true,
                DBInstanceCount: 1,
                DBInstanceClass: 'db.t3.medium',
            })
        )

        assert(
            createInstanceStub.calledOnceWithExactly({
                Engine: 'docdb',
                DBClusterIdentifier: clusterName,
                DBInstanceIdentifier: clusterName,
                DBInstanceClass: 'db.t3.medium',
            })
        )

        sandbox.assert.calledWith(spyExecuteCommand, 'aws.refreshAwsExplorerNode', node)
    })

    it('does nothing when prompt is cancelled', async function () {
        // arrange
        const stub = sinon.stub()
        docdb.createCluster = stub
        getTestWindow().onDidShowInputBox((input) => input.hide())

        // act
        await createCluster(node)

        // assert
        assert(stub.notCalled)
    })

    it('shows an error when cluster creation fails', async function () {
        // arrange
        const stub = sinon.stub().rejects()
        docdb.createCluster = stub
        setupWizard()

        // act
        await createCluster(node)

        // assert
        getTestWindow()
            .getFirstMessage()
            .assertError(/Failed to create cluster: docdb-1234/)
    })

    it('shows an error when instance creation fails', async function () {
        // arrange
        docdb.createCluster = sinon.stub().resolves({ DBClusterIdentifier: clusterName })
        docdb.createInstance = sinon.stub().rejects()
        setupWizard()

        // act
        await createCluster(node)

        // assert
        getTestWindow()
            .getFirstMessage()
            .assertError(/Failed to create cluster: docdb-1234/)
    })
})
