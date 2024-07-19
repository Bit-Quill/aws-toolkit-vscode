/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { inspect } from 'util'
import { AWSTreeNodeBase } from '../../shared/treeview/nodes/awsTreeNodeBase'
import { DBInstance } from '../../shared/clients/docdbClient'
import { DocDBContext, DocDBNodeContext } from './docdbNode'
import { DBClusterNode } from './dbClusterNode'
import { ModifyDBInstanceMessage } from '@aws-sdk/client-docdb'
import { waitUntil } from '../../shared'

/**
 * An AWS Explorer node representing a DocumentDB instance.
 */
export class DBInstanceNode extends AWSTreeNodeBase {
    public name: string = this.instance.DBInstanceIdentifier ?? ''

    constructor(public readonly parent: DBClusterNode, readonly instance: DBInstance) {
        super(instance.DBInstanceIdentifier ?? '[Instance]', vscode.TreeItemCollapsibleState.None)
        this.id = instance.DBInstanceArn
        this.description = this.makeDescription()
        this.contextValue = this.getContext()
        this.tooltip = `${this.name}\nClass: ${this.instance.DBInstanceClass}\nStatus: ${this.status}`
    }

    private makeDescription(): string {
        if (this.getContext() !== DocDBContext.InstanceAvailable) {
            return `${this.status} • ${this.instance.DBInstanceClass}`
        }
        const type = this.instance.IsClusterWriter ? 'primary' : 'replica'
        return `${type} • ${this.instance.DBInstanceClass}`
    }

    private getContext(): DocDBNodeContext {
        if (this.status === 'available') {
            return DocDBContext.InstanceAvailable
        }
        return DocDBContext.Instance
    }

    public async rebootInstance(): Promise<boolean> {
        const client = this.parent.client
        return await client.rebootInstance(this.instance.DBInstanceIdentifier!)
    }

    public async renameInstance(instanceName: string): Promise<DBInstance | undefined> {
        const request: ModifyDBInstanceMessage = {
            DBInstanceIdentifier: this.instance.DBInstanceIdentifier,
            NewDBInstanceIdentifier: instanceName,
            ApplyImmediately: true,
        }
        return await this.parent.client.modifyInstance(request)
    }

    public get status(): string | undefined {
        return this.instance.DBInstanceStatus
    }

    public async waitUntilStatusChanged(): Promise<boolean> {
        const currentStatus = this.status
        const instanceId = this.instance.DBInstanceIdentifier!

        await waitUntil(
            async () => {
                const instance = await this.parent.client.getInstance(instanceId)
                return instance?.DBInstanceStatus !== currentStatus
            },
            { timeout: 30000, interval: 500, truthy: true }
        )

        return false
    }

    public [inspect.custom](): string {
        return 'DBInstanceNode'
    }
}
