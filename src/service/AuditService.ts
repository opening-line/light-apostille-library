import { PublicAccount, NetworkType, TransactionHttp, Transaction,
   AggregateTransaction, TransferTransaction, BlockchainHttp, Address } from 'nem2-sdk';
import { AuditPayload } from '../utils/utils';
import { AuditResult } from '../model/AuditResult';

export class AuditService {

  private ownerPublicAccount?: PublicAccount;

  private coreTransaction?: TransferTransaction;

  constructor(private readonly data: string,
              private readonly txHash: string,
              private readonly url: string,
              private networkType: NetworkType,
    ) { }

  public async audit() {
    try {
      const transaction = await this.getTransaction();
      if (!this.isValidTransactionType(transaction)) {
        throw Error('invalid transaction');
      }
      this.parseInnerTransaction(transaction as AggregateTransaction);
      const payload = this.getCoreTransactionPayload();
      const auditResult = AuditPayload.audit(this.data, payload,
                                             this.ownerPublicAccount!.publicKey, this.networkType);
      if (auditResult) {
        return this.auditResult();
      } else {
        return new AuditResult(false);
      }
    } catch (err) {
      throw err;
    }
  }

  private async auditResult() {
    const fileHash = this.coreTransaction!.message.payload;
    const apostilleAddress = this.coreTransaction!.recipient as Address;
    const timestamp = await this.getTransactionTimestamp(this.coreTransaction!);
    return new AuditResult(true, this.txHash,
                           fileHash, this.ownerPublicAccount,
                           apostilleAddress, timestamp);
  }

  private async getTransaction() {
    const transactionHttp = new TransactionHttp(this.url);
    try {
      return await transactionHttp.getTransaction(this.txHash).toPromise();
    } catch (err) {
      // TODO: API response error
      throw err;
    }
  }

  private parseInnerTransaction(transaction: AggregateTransaction) {
    transaction.innerTransactions.forEach((innerTransaction) => {
      if (innerTransaction instanceof TransferTransaction) {
        if (innerTransaction.message.payload.startsWith('fe4e5459')) {
          this.coreTransaction = innerTransaction;
          this.ownerPublicAccount = innerTransaction.signer;
        }
      }
    });

    if (!this.coreTransaction) {
      throw Error('core transaction not founded');
    }
  }

  private getCoreTransactionPayload() {
    return this.getPayload(this.coreTransaction!);
  }

  private getPayload(transaction: TransferTransaction) {
    return transaction.message.payload;
  }

  private isValidTransactionType(transaction: Transaction) {
    if (transaction instanceof AggregateTransaction) {
      return true;
    }
    return false;
  }

  private async getTransactionTimestamp(transaction: Transaction) {
    const blockHeight = transaction.transactionInfo!.height;
    const blockchainHttp = new BlockchainHttp(this.url);
    const blockInfo = await blockchainHttp.getBlockByHeight(blockHeight.compact()).toPromise();
    const timestamp = blockInfo.timestamp.compact();
    return timestamp + new Date(Date.UTC(2016, 3, 1, 0, 0, 0, 0)).getTime();
  }

  public static audit(data: string, txHash: string,
                      url: string, networkType: NetworkType) {
    const auditService = new AuditService(data, txHash, url, networkType);
    return auditService.audit();
  }
}