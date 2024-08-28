/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { inspect } from 'util'
import { AWSTreeNodeBase } from '../../shared/treeview/nodes/awsTreeNodeBase'
import { DBResourceNode } from './dbResourceNode'
import { DBElasticCluster, DocumentDBClient } from '../../shared/clients/docdbClient'
import { DocDBContext } from './docdbContext'
import { copyToClipboard } from '../../shared/utilities/messages'
import { localize } from '../../shared/utilities/vsCodeUtils'

/**
 * An AWS Explorer node representing DocumentDB elastic clusters.
 */
export class DBElasticClusterNode extends DBResourceNode {
    override name = this.cluster.clusterName!
    override arn = this.cluster.clusterArn!

    constructor(
        public readonly parent: AWSTreeNodeBase,
        public cluster: DBElasticCluster,
        client: DocumentDBClient
    ) {
        super(client, cluster.clusterName ?? '[Cluster]', vscode.TreeItemCollapsibleState.None)
        this.contextValue = this.getContext()
        this.iconPath = new vscode.ThemeIcon(
            this.isAvailable ? 'layers-active' : this.isStopped ? 'layers-dot' : 'loading~spin'
        )
        this.description = this.getDescription()
        this.tooltip = `${this.name}\nStatus: ${this.status}`
    }

    private getContext() {
        if (this.isAvailable) {
            return `${DocDBContext.ElasticCluster}-running`
        } else if (this.isStopped) {
            return `${DocDBContext.ElasticCluster}-stopped`
        }
        return DocDBContext.ElasticCluster
    }

    public getDescription(): string | boolean {
        if (!this.isAvailable) {
            return `Elastic cluster • ${this.status}`
        }
        return 'Elastic cluster'
    }

    public async deleteCluster(finalSnapshotId: string | undefined): Promise<DBElasticCluster | undefined> {
        if (finalSnapshotId !== undefined) {
            void vscode.window.showInformationMessage(
                localize('AWS.docdb.deleteCluster.snapshot', 'Taking snapshot of cluster: {0}', this.name)
            )

            await this.client.createClusterSnapshot({
                clusterArn: this.cluster.clusterArn,
                snapshotName: finalSnapshotId,
            })
        }
        return await this.client.deleteElasticCluster(this.arn)
    }

    override get status() {
        return this.cluster.status?.toLowerCase()
    }

    override async getStatus() {
        const cluster = await this.client.getElasticCluster(this.arn)
        return cluster?.status
    }

    override get isAvailable() {
        return this.status === 'active'
    }

    override getConsoleUrl() {
        const region = this.regionCode
        return vscode.Uri.parse(
            `https://${region}.console.aws.amazon.com/docdb/home?region=${region}#elastic-cluster-details/${this.arn}`
        )
    }

    override async copyEndpoint() {
        // get the full cluster record if we don't have it already
        if (this.cluster.clusterEndpoint === undefined) {
            this.cluster = (await this.client.getElasticCluster(this.arn)) ?? this.cluster
        }
        await copyToClipboard(this.cluster.clusterEndpoint!, this.name)
    }

    public [inspect.custom](): string {
        return 'DBElasticClusterNode'
    }
}