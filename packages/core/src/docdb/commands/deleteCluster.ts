/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { getLogger } from '../../shared'
import { localize } from '../../shared/utilities/vsCodeUtils'
import { showViewLogsMessage } from '../../shared/utilities/messages'
import { DBClusterNode } from '../explorer/dbClusterNode'
import { showQuickPick } from '../../shared/ui/pickerPrompter'
import { formatDate, formatTime } from '../utils'

/**
 * Deletes a DocumentDB cluster.
 *
 * Prompts the user for confirmation, and whether to keep a snapshot
 * Deletes the cluster and all instances.
 * Refreshes the cluster node.
 */
export async function deleteCluster(node: DBClusterNode) {
    getLogger().debug('DeleteCluster called for: %O', node)

    if (!node) {
        throw new Error('No node specified for DeleteCluster')
    }

    const clusterName = node.cluster.DBClusterIdentifier!

    if (node.cluster.DeletionProtection) {
        void vscode.window.showErrorMessage(
            localize(
                'AWS.docdb.deleteCluster.protected',
                'Clusters cannot be deleted while deletion protection is enabled'
            )
        )
        return
    }

    if (node.status !== 'available') {
        void vscode.window.showErrorMessage(
            localize('AWS.docdb.deleteCluster.clusterStopped', 'Cluster must be running')
        )
        return
    }

    const takeSnapshot = await showQuickPick(
        [
            { label: localize('AWS.generic.response.yes', 'Yes'), data: true },
            { label: localize('AWS.generic.response.no', 'No'), data: false },
        ],
        {
            title: localize('AWS.docdb.deleteCluster.promptSnapshot', 'Delete Cluster - Keep a snapshot of the data?'),
        }
    )
    if (takeSnapshot === undefined) {
        getLogger().info('DeleteCluster cancelled')
        return
    }

    const isConfirmed = await showConfirmationDialog()
    if (!isConfirmed) {
        getLogger().info('DeleteCluster cancelled')
        return
    }

    try {
        getLogger().info(`Deleting cluster: ${clusterName}`)

        let finalSnapshotId: string | undefined = undefined
        if (takeSnapshot) {
            const timestamp = `${formatDate()}-${formatTime()}`
            finalSnapshotId = `${clusterName}-${timestamp}`
        }

        const cluster = await node.deleteCluster(finalSnapshotId)

        void vscode.window.showInformationMessage(
            localize('AWS.docdb.deleteCluster.success', 'Deleting cluster: {0}', clusterName)
        )

        await node.waitUntilStatusChanged()
        node.parent.refresh()
        getLogger().info('Deleted cluster: %O', cluster)
        return cluster
    } catch (e) {
        getLogger().error(`Failed to delete cluster ${clusterName}: %s`, e)
        void showViewLogsMessage(
            localize('AWS.docdb.deleteCluster.error', 'Failed to delete cluster: {0}', clusterName)
        )
    }
}

async function showConfirmationDialog(): Promise<boolean> {
    const prompt = localize('AWS.docdb.deleteCluster.prompt', "Enter 'delete entire cluster' to confirm deletion")
    const confirmValue = localize('AWS.docdb.deleteCluster.confirmValue', 'delete entire cluster').toLowerCase()
    const confirmationInput = await vscode.window.showInputBox({
        prompt,
        placeHolder: confirmValue,
        validateInput: (input) => (input?.toLowerCase() !== confirmValue ? prompt : undefined),
    })

    return confirmationInput === confirmValue
}
