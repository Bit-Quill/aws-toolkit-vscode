/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import * as sinon from 'sinon'
import * as vscode from 'vscode'
import { getTestWindow } from '../../shared/vscode/window'
import { DocumentDBClient, DBInstance } from '../../../shared/clients/docdbClient'
import { DBClusterNode } from '../../../docdb/explorer/dbClusterNode'
import { DBInstanceNode } from '../../../docdb/explorer/dbInstanceNode'
import { DocumentDBNode } from '../../../docdb/explorer/docdbNode'
import { rebootInstance } from '../../../docdb/commands/rebootInstance'

describe('rebootInstanceCommand', function () {
    const instanceName = 'test-instance'
    let docdb: DocumentDBClient
    let instance: DBInstance
    let node: DBInstanceNode
    let sandbox: sinon.SinonSandbox
    let spyExecuteCommand: sinon.SinonSpy

    beforeEach(function () {
        sandbox = sinon.createSandbox()
        spyExecuteCommand = sandbox.spy(vscode.commands, 'executeCommand')

        docdb = { regionCode: 'us-east-1' } as DocumentDBClient
        const clusterName = 'docdb-1234'
        const cluster = { DBClusterIdentifier: clusterName, Status: 'available' }
        const parentNode = new DBClusterNode(new DocumentDBNode(docdb), cluster, docdb)
        instance = {
            DBInstanceIdentifier: instanceName,
            DBClusterIdentifier: clusterName,
            DBInstanceStatus: 'available',
        }
        node = new DBInstanceNode(parentNode, instance)
    })

    afterEach(function () {
        sandbox.restore()
        getTestWindow().dispose()
    })

    it('reboots instance, and refreshes parent node', async function () {
        // arrange
        const stub = sinon.stub().resolves(true)
        docdb.rebootInstance = stub

        // act
        await rebootInstance(node)

        // assert
        getTestWindow()
            .getFirstMessage()
            .assertInfo(/Rebooting instance: test-instance/)

        assert(stub.calledOnceWithExactly(instanceName))
        sandbox.assert.calledWith(spyExecuteCommand, 'aws.refreshAwsExplorerNode', node.parent)
    })

    it('shows an error when api returns failure', async function () {
        // arrange
        const stub = sinon.stub().rejects()
        docdb.rebootInstance = stub

        // act
        await rebootInstance(node)

        // assert
        getTestWindow()
            .getFirstMessage()
            .assertError(/Failed to reboot instance: test-instance/)
    })

    it('shows a warning when the instance is not available', async function () {
        // arrange
        instance.DBInstanceStatus = 'stopped'
        const stub = sinon.stub()
        docdb.rebootInstance = stub

        // act
        await rebootInstance(node)

        // assert
        getTestWindow()
            .getFirstMessage()
            .assertMessage(/Instance must be running/)
    })
})
