import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ============================================================================
// Module Mocks
// ============================================================================

vi.mock('../../src/index.js', () => ({
    getBackupConfig: vi.fn(() => ({
        outputDir: '/mock/backup_downloads',
        jobId: 'test-backup-job',
        ocapiVersion: 'v23_2',
        pollIntervalMs: 100,
        timeoutMs: 5000
    })),
    getWebdavConfig: vi.fn((realm) => ({
        hostname: `${realm.toLowerCase()}-host.example.com`,
        name: realm,
        username: 'webdav-user',
        password: 'webdav-pass'
    }))
}));

vi.mock('../../src/api/api.js', () => ({
    triggerJobExecution: vi.fn(),
    getJobExecutionStatus: vi.fn(),
    downloadWebdavFile: vi.fn()
}));

// ============================================================================
// Imports — after mocks
// ============================================================================

import {
    buildMetadataBackupFileName,
    refreshMetadataBackupForRealm,
    getMetadataBackupPathForRealm
} from '../../src/helpers/backupJob.js';
import { getBackupConfig, getWebdavConfig } from '../../src/index.js';
import {
    triggerJobExecution,
    getJobExecutionStatus,
    downloadWebdavFile
} from '../../src/api/api.js';

// ============================================================================
// buildMetadataBackupFileName
// ============================================================================

describe('buildMetadataBackupFileName', () => {
    it('builds filename with realm and current date', () => {
        const fileName = buildMetadataBackupFileName('EU05');
        const date = new Date().toISOString().slice(0, 10);

        expect(fileName).toBe(`EU05_meta_data_backup_${date}.xml`);
    });

    it('sanitizes special characters in realm identifier', () => {
        const fileName = buildMetadataBackupFileName('realm/with:special chars');
        expect(fileName).not.toContain('/');
        expect(fileName).not.toContain(':');
        expect(fileName).toMatch(/^[\w.-]+_meta_data_backup_\d{4}-\d{2}-\d{2}\.xml$/);
    });

    it('uses "unknown" for null or undefined realm', () => {
        const fileName = buildMetadataBackupFileName(null);
        expect(fileName).toContain('unknown_meta_data_backup_');

        const fileName2 = buildMetadataBackupFileName(undefined);
        expect(fileName2).toContain('unknown_meta_data_backup_');
    });

    it('uses "unknown" for empty string realm', () => {
        const fileName = buildMetadataBackupFileName('');
        expect(fileName).toContain('unknown_meta_data_backup_');
    });

    it('preserves dots and hyphens in realm name', () => {
        const fileName = buildMetadataBackupFileName('host-name.example.com');
        expect(fileName).toContain('host-name.example.com_meta_data_backup_');
    });
});

// ============================================================================
// getMetadataBackupPathForRealm
// ============================================================================

describe('getMetadataBackupPathForRealm', () => {
    it('returns full path combining outputDir and filename', () => {
        const result = getMetadataBackupPathForRealm('EU05');
        const date = new Date().toISOString().slice(0, 10);

        expect(result).toBe(
            path.join('/mock/backup_downloads', `EU05_meta_data_backup_${date}.xml`)
        );
    });

    it('uses webdav config name for realm identifier', () => {
        getWebdavConfig.mockReturnValueOnce({
            hostname: 'host.example.com',
            name: 'APAC',
            username: 'user',
            password: 'pass'
        });

        const result = getMetadataBackupPathForRealm('APAC');
        expect(result).toContain('APAC_meta_data_backup_');
    });

    it('falls back to hostname when name is absent', () => {
        getWebdavConfig.mockReturnValueOnce({
            hostname: 'dev-eu05.example.com',
            username: 'user',
            password: 'pass'
        });

        const result = getMetadataBackupPathForRealm('EU05');
        expect(result).toContain('dev-eu05.example.com_meta_data_backup_');
    });
});

// ============================================================================
// refreshMetadataBackupForRealm
// ============================================================================

describe('refreshMetadataBackupForRealm', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backupjob-test-'));
        vi.spyOn(console, 'log').mockImplementation(() => {});

        // Clear all mock state from previous tests
        triggerJobExecution.mockReset();
        getJobExecutionStatus.mockReset();
        downloadWebdavFile.mockReset();

        // Reset mocks to defaults
        getBackupConfig.mockReturnValue({
            outputDir: tmpDir,
            jobId: 'test-backup-job',
            ocapiVersion: 'v23_2',
            pollIntervalMs: 10,
            timeoutMs: 5000
        });

        getWebdavConfig.mockReturnValue({
            hostname: 'dev-eu05.example.com',
            name: 'EU05',
            username: 'webdav-user',
            password: 'webdav-pass'
        });
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('returns error when config is missing', async () => {
        getBackupConfig.mockImplementation(() => {
            throw new Error('Config not found');
        });

        const result = await refreshMetadataBackupForRealm('EU05', 'development');

        expect(result.ok).toBe(false);
        expect(result.reason).toContain('Config not found');
    });

    it('returns existing file when download succeeds on first try', async () => {
        const date = new Date().toISOString().slice(0, 10);
        const expectedFile = path.join(tmpDir, `EU05_meta_data_backup_${date}.xml`);

        // Simulate WebDAV download returning a valid path
        downloadWebdavFile.mockResolvedValue(expectedFile);
        // Create the file so fs.access succeeds
        fs.writeFileSync(expectedFile, '<xml>test</xml>', 'utf-8');

        const result = await refreshMetadataBackupForRealm('EU05', 'development');

        expect(result.ok).toBe(true);
        expect(result.filePath).toBe(expectedFile);
        expect(result.status).toBe('EXISTING');
        // Should not have triggered a backup job
        expect(triggerJobExecution).not.toHaveBeenCalled();
    });

    it('triggers backup job when initial download returns null', async () => {
        const date = new Date().toISOString().slice(0, 10);
        const expectedFile = path.join(tmpDir, `EU05_meta_data_backup_${date}.xml`);

        // First download fails, second (after job) creates and returns the file
        downloadWebdavFile
            .mockResolvedValueOnce(null)
            .mockImplementationOnce(async () => {
                fs.writeFileSync(expectedFile, '<xml>fresh</xml>', 'utf-8');
                return expectedFile;
            });

        // Job trigger succeeds
        triggerJobExecution.mockResolvedValue({ id: 'exec-123' });

        // Job completes successfully
        getJobExecutionStatus.mockResolvedValue({
            execution_status: 'finished',
            exit_status: { status: 'ok' }
        });

        const result = await refreshMetadataBackupForRealm('EU05', 'development');

        expect(result.ok).toBe(true);
        expect(result.filePath).toBe(expectedFile);
        expect(triggerJobExecution).toHaveBeenCalled();
    });

    it('returns error when backup job fails to trigger', async () => {
        downloadWebdavFile.mockResolvedValue(null);
        triggerJobExecution.mockResolvedValue(null);

        const result = await refreshMetadataBackupForRealm('EU05', 'development');

        expect(result.ok).toBe(false);
        expect(result.reason).toContain('Failed to trigger backup job');
    });

    it('returns error when execution response has no ID', async () => {
        downloadWebdavFile.mockResolvedValue(null);
        triggerJobExecution.mockResolvedValue({ status: 'ok' });

        const result = await refreshMetadataBackupForRealm('EU05', 'development');

        expect(result.ok).toBe(false);
        expect(result.reason).toContain('Missing execution ID');
    });

    it('returns error when job finishes with failure', async () => {
        downloadWebdavFile.mockResolvedValue(null);
        triggerJobExecution.mockResolvedValue({ id: 'exec-456' });
        getJobExecutionStatus.mockResolvedValue({
            execution_status: 'finished',
            exit_status: { status: 'error' }
        });

        const result = await refreshMetadataBackupForRealm('EU05', 'development');

        expect(result.ok).toBe(false);
        expect(result.reason).toContain('FAILED');
    });

    it('returns error when job is aborted', async () => {
        downloadWebdavFile.mockResolvedValue(null);
        triggerJobExecution.mockResolvedValue({ id: 'exec-789' });
        getJobExecutionStatus.mockResolvedValue({
            execution_status: 'aborted'
        });

        const result = await refreshMetadataBackupForRealm('EU05', 'development');

        expect(result.ok).toBe(false);
        expect(result.reason).toContain('FAILED');
    });

    it('returns error when no jobId is configured', async () => {
        getBackupConfig.mockReturnValue({
            outputDir: tmpDir,
            jobId: null,
            ocapiVersion: 'v23_2',
            pollIntervalMs: 10,
            timeoutMs: 5000
        });

        downloadWebdavFile.mockResolvedValue(null);

        const result = await refreshMetadataBackupForRealm('EU05', 'development');

        expect(result.ok).toBe(false);
        expect(result.reason).toContain('no backup.jobId configured');
    });

    it('handles force job execution mode', async () => {
        const date = new Date().toISOString().slice(0, 10);
        const expectedFile = path.join(tmpDir, `EU05_meta_data_backup_${date}.xml`);

        triggerJobExecution.mockResolvedValue({ id: 'exec-force' });
        getJobExecutionStatus.mockResolvedValue({
            execution_status: 'finished',
            exit_status: { status: 'ok' }
        });
        downloadWebdavFile.mockImplementation(async () => {
            fs.writeFileSync(expectedFile, '<xml>forced</xml>', 'utf-8');
            return expectedFile;
        });

        const result = await refreshMetadataBackupForRealm('EU05', 'development', {
            forceJobExecution: true
        });

        expect(result.ok).toBe(true);
        expect(triggerJobExecution).toHaveBeenCalledWith(
            'test-backup-job',
            'EU05',
            'v23_2'
        );
    });

    it('returns error when post-job download fails', async () => {
        downloadWebdavFile
            .mockResolvedValueOnce(null) // initial attempt
            .mockResolvedValueOnce(null); // after job completes

        triggerJobExecution.mockResolvedValue({ id: 'exec-dl-fail' });
        getJobExecutionStatus.mockResolvedValue({
            execution_status: 'finished',
            exit_status: { status: 'ok' }
        });

        const result = await refreshMetadataBackupForRealm('EU05', 'development');

        expect(result.ok).toBe(false);
        expect(result.reason).toContain('failed to download');
    });

    it('returns error when downloaded file does not exist on disk', async () => {
        const nonExistentPath = path.join(tmpDir, 'does_not_exist.xml');

        downloadWebdavFile
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(nonExistentPath); // returns path but file doesn't exist

        triggerJobExecution.mockResolvedValue({ id: 'exec-ghost' });
        getJobExecutionStatus.mockResolvedValue({
            execution_status: 'finished',
            exit_status: { status: 'ok' }
        });

        const result = await refreshMetadataBackupForRealm('EU05', 'development');

        expect(result.ok).toBe(false);
        expect(result.reason).toContain('Downloaded file not found');
    });

    it('catches unexpected errors and returns error result', async () => {
        downloadWebdavFile.mockRejectedValue(new Error('Network failure'));

        const result = await refreshMetadataBackupForRealm('EU05', 'development');

        expect(result.ok).toBe(false);
        expect(result.reason).toContain('Network failure');
    });

    it('archives old metadata files before downloading cached version', async () => {
        const date = new Date().toISOString().slice(0, 10);
        const expectedFile = path.join(tmpDir, `EU05_meta_data_backup_${date}.xml`);

        // Create an old file to be archived
        const oldFile = path.join(tmpDir, 'EU05_meta_data_backup_2020-01-01.xml');
        fs.writeFileSync(oldFile, '<old/>', 'utf-8');

        downloadWebdavFile.mockResolvedValue(expectedFile);
        fs.writeFileSync(expectedFile, '<xml>test</xml>', 'utf-8');

        const result = await refreshMetadataBackupForRealm('EU05', 'development');

        expect(result.ok).toBe(true);
        // Old file should have been moved to archive
        expect(fs.existsSync(oldFile)).toBe(false);
        const archiveDir = path.join(tmpDir, 'archive');
        expect(fs.existsSync(archiveDir)).toBe(true);
    });

    it('returns error when no jobId and forced', async () => {
        getBackupConfig.mockReturnValue({
            outputDir: tmpDir,
            jobId: null,
            ocapiVersion: 'v23_2',
            pollIntervalMs: 10,
            timeoutMs: 5000
        });

        const result = await refreshMetadataBackupForRealm('EU05', 'development', {
            forceJobExecution: true
        });

        expect(result.ok).toBe(false);
        expect(result.reason).toContain('Cannot force fresh metadata');
    });

    it('handles execution_id field in job response', async () => {
        const date = new Date().toISOString().slice(0, 10);
        const expectedFile = path.join(tmpDir, `EU05_meta_data_backup_${date}.xml`);

        downloadWebdavFile
            .mockResolvedValueOnce(null)
            .mockImplementationOnce(async () => {
                fs.writeFileSync(expectedFile, '<xml/>', 'utf-8');
                return expectedFile;
            });
        triggerJobExecution.mockResolvedValue({ execution_id: 'alt-exec-id' });
        getJobExecutionStatus.mockResolvedValue({
            execution_status: 'finished',
            exit_status: { status: 'ok' }
        });

        const result = await refreshMetadataBackupForRealm('EU05', 'development');

        expect(result.ok).toBe(true);
    });

    it('polls job status until it reaches a terminal state', async () => {
        const date = new Date().toISOString().slice(0, 10);
        const expectedFile = path.join(tmpDir, `EU05_meta_data_backup_${date}.xml`);

        downloadWebdavFile
            .mockResolvedValueOnce(null)
            .mockImplementationOnce(async () => {
                fs.writeFileSync(expectedFile, '<xml/>', 'utf-8');
                return expectedFile;
            });
        triggerJobExecution.mockResolvedValue({ id: 'exec-poll' });

        // Simulate pending → running → finished
        getJobExecutionStatus
            .mockResolvedValueOnce({ execution_status: 'pending' })
            .mockResolvedValueOnce({ execution_status: 'running' })
            .mockResolvedValueOnce({
                execution_status: 'finished',
                exit_status: { status: 'ok' }
            });

        const result = await refreshMetadataBackupForRealm('EU05', 'development');

        expect(result.ok).toBe(true);
        expect(getJobExecutionStatus).toHaveBeenCalledTimes(3);
    });

    it('returns null status response when getJobExecutionStatus returns null', async () => {
        downloadWebdavFile.mockResolvedValue(null);
        triggerJobExecution.mockResolvedValue({ id: 'exec-null-status' });
        getJobExecutionStatus.mockResolvedValue(null);

        const result = await refreshMetadataBackupForRealm('EU05', 'development');

        expect(result.ok).toBe(false);
        expect(result.reason).toContain('ERROR');
    });
});
