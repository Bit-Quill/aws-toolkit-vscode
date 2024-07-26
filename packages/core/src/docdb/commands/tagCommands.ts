/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { getLogger } from '../../shared/logger'
import { telemetry } from '../../shared/telemetry'
import { localize } from '../../shared/utilities/vsCodeUtils'
import { DBResourceNode } from '../explorer/dbResourceNode'
import { DataQuickPickItem, showQuickPick } from '../../shared/ui/pickerPrompter'
import { ToolkitError } from '../../shared'

export async function listTags(node: DBResourceNode): Promise<void> {
    return telemetry.docdb_listTags.run(async () => {
        const tags = await node.listTags()
        const detail = tags.length
            ? tags.map((tag) => `• ${tag.Key} = ${tag.Value}`).join('\r\n')
            : '[No tags assigned]'

        const addCommandText = localize('AWS.docdb.tags.add', 'Add tag...')
        const removeCommandText = tags.length ? localize('AWS.docdb.tags.remove', 'Remove...') : ''
        const commands = tags.length ? [addCommandText, removeCommandText] : [addCommandText]

        const response = await vscode.window.showInformationMessage(
            `Tags for ${node.name}:`,
            { modal: true, detail },
            ...commands
        )

        switch (response) {
            case addCommandText:
                await addTag(node)
                break
            case removeCommandText:
                await removeTag(node)
                break
        }
    })
}

export async function addTag(node: DBResourceNode): Promise<void> {
    return telemetry.docdb_addTag.run(async () => {
        const key = await vscode.window.showInputBox({
            title: 'Add Tag',
            prompt: localize('AWS.docdb.tags.add.keyPrompt', 'Enter a key for the new tag'),
            validateInput: (input) => validateTag(input, 1, 'key'),
        })
        if (key === undefined) {
            getLogger().info('AddTag cancelled')
            throw new ToolkitError('User cancelled', { cancelled: true })
        }

        const value = await vscode.window.showInputBox({
            title: 'Add Tag',
            prompt: localize('AWS.docdb.tags.add.valuePrompt', 'Enter the value for the new tag (optional)'),
            validateInput: (input) => validateTag(input, 0, 'value'),
        })
        if (value === undefined) {
            getLogger().info('AddTag cancelled')
            throw new ToolkitError('User cancelled', { cancelled: true })
        }

        const tag = { Key: key.trim(), Value: value.trim() }
        await node.client.addResourceTags({ ResourceName: node.arn, Tags: [tag] })
        getLogger().info('Added resource tag for: %O', node.name)
        void vscode.window.showInformationMessage(localize('AWS.docdb.tags.add.success', 'Tag added'))
    })
}

export async function removeTag(node: DBResourceNode): Promise<void> {
    return telemetry.docdb_removeTag.run(async () => {
        const tags = await node.listTags()
        const items = tags.map<DataQuickPickItem<string>>((tag) => {
            return {
                data: tag.Key,
                label: tag.Key!,
                description: tag.Value,
            }
        })
        if (items.length === 0) {
            return
        }

        const resp = await showQuickPick(items, {
            title: localize('AWS.docdb.tags.remove.title', 'Remove a tag from {0}', node.name),
        })

        if (resp === undefined) {
            getLogger().info('RemoveTag cancelled')
            throw new ToolkitError('User cancelled', { cancelled: true })
        }

        await node.client.removeResourceTags({ ResourceName: node.arn, TagKeys: [resp] })
        getLogger().info('Removed resource tag for: %O', node.name)
        void vscode.window.showInformationMessage(localize('AWS.docdb.tags.remove.success', 'Tag removed'))
    })
}

export function validateTag(input: string, minLength: number, name: string): string | undefined {
    if (input.trim().length < minLength) {
        return localize('AWS.docdb.validateTag.error.invalidLength', `Tag ${name} cannot be blank`)
    }

    if (!/^([\p{L}\p{Z}\p{N}\._:/=+\-@]*)$/u.test(input)) {
        return localize(
            'AWS.docdb.validateTag.error.invalidCharacters',
            `Tag ${name} may only contain unicode letters, digits, whitespace, or one of these symbols: _ . : / = + - @`
        )
    }

    return undefined
}
