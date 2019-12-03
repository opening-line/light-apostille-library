import { HashFunction } from '../hash/HashFunction';
import { NetworkType, Account, TransferTransaction,
    Deadline, PlainMessage, InnerTransaction, AggregateTransaction,
    Listener, TransactionHttp, Transaction,
    MultisigAccountModificationTransaction,
    PublicAccount,
    SignedTransaction,
    HashLockTransaction,
    NetworkCurrencyMosaic,
    UInt64} from 'nem2-sdk';
import { ApostilleAccount, SignType } from '../model/ApostilleAccount';
import { filter, mergeMap } from 'rxjs/operators';
import { AnnounceResult } from '../model/AnnounceResult';
import * as NodeWebSocket from 'ws';
import { Sinks } from '../model/Sink';
import { MetadataTransaction } from '../model/MetadataTransaction';

export enum ApostilleServiceType {
  Create,
  Update,
}

export class ApostilleService {

  private ownerAccount: Account;
  private apostilleAccount: ApostilleAccount;

  private coreTransaction?: InnerTransaction;
  private announcePublicSinkTransaction?: InnerTransaction;
  private legacyMetadataTransaction?: InnerTransaction;
  private metadataTransactions?: InnerTransaction[];
  private assignOwnershipTransaction?: InnerTransaction;

  public static createApostille(data: string,
                                filename: string,
                                hashFunction: HashFunction,
                                ownerPrivateKey: string,
                                url: string,
                                networkType: NetworkType,
                                networkGenerationHash: string,
                                isFeeNetwork?: boolean,
    ) {
    return new ApostilleService(data, filename, hashFunction,
                                url, networkType, ownerPrivateKey, networkGenerationHash,
                                ApostilleServiceType.Create, undefined, isFeeNetwork);
  }

  public static updateApostille(data: string,
                                filename: string,
                                hashFunction: HashFunction,
                                ownerPrivateKey: string,
                                url: string,
                                networkType: NetworkType,
                                networkGenerationHash: string,
                                apostilleAccount: Account | PublicAccount,
                                isFeeNetwork?: boolean,
                                ) {
    return new ApostilleService(data, filename, hashFunction,
                                url, networkType, ownerPrivateKey,
                                networkGenerationHash,
                                ApostilleServiceType.Update,
                                apostilleAccount, isFeeNetwork);
  }

  /**
   * @deprecated
   * Public use will be deprecated.
   * You should replace ApostilleService.createApostille or ApostilleService.updateApostille
   */
  public constructor(private data: string,
                     filename: string,
                     private hashFunction: HashFunction,
                     private url: string,
                     private networkType: NetworkType,
                     ownerPrivateKey: string,
                     private networkGenerationHash,
                     private serviceType?: ApostilleServiceType,
                     existApostilleAccount?: Account | PublicAccount,
                     private isFeeNetwork?: boolean) {
    this.ownerAccount = Account.createFromPrivateKey(ownerPrivateKey, networkType);
    if (!this.serviceType) {
      this.serviceType = ApostilleServiceType.Create;
    }
    if (existApostilleAccount) {
      this.apostilleAccount = ApostilleAccount.createWithExistAccount(existApostilleAccount);
    } else {
      this.apostilleAccount = ApostilleAccount.create(filename, this.ownerAccount);
    }
  }

  public createCoreTransaction() {
    const transaction = TransferTransaction.create(
      Deadline.create(),
      this.apostilleAccount.address,
      [],
      PlainMessage.create(this.signedFileHash()),
      this.networkType,
    );
    this.coreTransaction = transaction.toAggregate(this.ownerAccount.publicAccount);
  }

  public addAnnouncePublicSinkTransaction() {
    const sinkAddress = Sinks.getAddress(this.networkType);
    const transaction = TransferTransaction.create(
      Deadline.create(),
      sinkAddress,
      [],
      PlainMessage.create(this.signedFileHash()),
      this.networkType,
    );
    this.announcePublicSinkTransaction =
      transaction.toAggregate(this.apostilleAccount.publicAccount);
  }

  /**
   * @deprecated
   */
  public createAnnouncePublicSinkTransaction() {
    this.addAnnouncePublicSinkTransaction();
  }

  public addAssignOwnershipTransaction() {
    const transaction = MultisigAccountModificationTransaction.create(
      Deadline.create(),
      1,
      1,
      [
        this.ownerAccount.publicAccount,
      ],
      [],
      this.networkType,
    );
    this.assignOwnershipTransaction = transaction.toAggregate(this.apostilleAccount.publicAccount);
  }

  /**
   * @deprecated
   */
  public createAssignOwnershipTransaction() {
    this.addAssignOwnershipTransaction();
  }

  /**
   * @deprecated
   * InnerTransaction's metadata will be deprecated when NIP4 will be updated.
   * @param metadata
   */
  public addLegacyMetadataTransaction(metadata: any) {
    const message = JSON.stringify(metadata);
    const transaction = TransferTransaction.create(
      Deadline.create(),
      this.apostilleAccount.address,
      [],
      PlainMessage.create(message),
      this.networkType,
    );
    this.legacyMetadataTransaction = transaction.toAggregate(this.apostilleAccount.publicAccount);
  }

  public addMetadataTransaction(metadata: Object) {
    const transactions = MetadataTransaction
    .objectToMetadataTransactions(metadata,
                                  this.apostilleAccount.publicAccount,
                                  this.networkType);
    this.metadataTransactions = transactions;
  }

  /**
   * @deprecated
   * @param metadata
   */
  public createMetadataTransaction(metadata: any) {
    this.addLegacyMetadataTransaction(metadata);
  }

  public announce(webSocket?: any) {
    if (this.serviceType === ApostilleServiceType.Create) {
      return this.announceForCreate(webSocket);
    }
    return this.announceForUpdate(webSocket);
  }

  private announceForComplete(signedTransaction: SignedTransaction, webSocket?: any) {
    if (!this.canAnnounce()) {
      throw Error('can not announce');
    }

    // TODO: Temp comment
    console.log(`txHash: ${signedTransaction.hash}`);

    const transactionHttp = new TransactionHttp(this.url);
    const wsEndpoint = this.url.replace('http', 'ws');
    let ws = webSocket;
    if (!ws) {
      ws = NodeWebSocket.default;
    }
    const listener = new Listener(wsEndpoint, ws);
    return new Promise<AnnounceResult>((resolve, reject) => {
      listener.open().then(() => {
        listener
          .status(this.ownerAccount.address)
          .pipe(filter(error => error.hash === signedTransaction.hash))
          .subscribe((error) => {
            console.error(error);
            reject(error);
          });

        listener
          .unconfirmedAdded(this.ownerAccount.address)
          .pipe(
            filter((transaction => (transaction.transactionInfo !== undefined
              && transaction.transactionInfo.hash === signedTransaction.hash))),
          ).subscribe((result) => {
            const announceResult = new AnnounceResult(result.transactionInfo!.hash!,
                                                      this.signedFileHash(),
                                                      this.ownerAccount.publicAccount,
                                                      this.apostilleAccount);
            listener.close();
            resolve(announceResult);
          });

        transactionHttp.announce(signedTransaction).subscribe(
            x => console.log(x),
            err => reject(err),
          );
      });
    });
  }

  private announceForBonded(signedTransaction: SignedTransaction, webSocket?: any) {
    if (!this.canAnnounce()) {
      throw Error('can not announce');
    }

    // TODO: Temp comment
    console.log(`txHash: ${signedTransaction.hash}`);

    const hashLockTransaction = HashLockTransaction.create(
      Deadline.create(),
      NetworkCurrencyMosaic.createRelative(10),
      UInt64.fromUint(480),
      signedTransaction,
      this.networkType,
    );

    const hashLockTransactionSigned = this.ownerAccount.sign(hashLockTransaction,
                                                             this.networkGenerationHash);
    const transactionHttp = new TransactionHttp(this.url);
    const wsEndpoint = this.url.replace('http', 'ws');
    let ws = webSocket;
    if (!ws) {
      ws = NodeWebSocket.default;
    }
    const listener = new Listener(wsEndpoint, ws);
    return new Promise<AnnounceResult>((resolve, reject) => {
      listener.open().then(() => {
        transactionHttp.announce(hashLockTransactionSigned)
        .subscribe(x => console.log(x),
                   (err) => {
                     console.error(err);
                     reject(err);
                   });
      });
      listener.confirmed(this.ownerAccount.address)
      .pipe(
        filter(transaction => transaction.transactionInfo !== undefined &&
        transaction.transactionInfo.hash === hashLockTransactionSigned.hash),
        mergeMap(ignored => transactionHttp.announceAggregateBonded(signedTransaction)),
      );
      listener.unconfirmedAdded(this.ownerAccount.address)
      .pipe(
        filter((transaction => transaction.transactionInfo !== undefined &&
          transaction.transactionInfo.hash === signedTransaction.hash)),
      ).subscribe((result) => {
        const announceResult = new AnnounceResult(
          result.transactionInfo!.hash!,
          this.signedFileHash(),
          this.ownerAccount.publicAccount,
          this.apostilleAccount,
        );
        listener.close(),
        resolve(announceResult);
      },
      );
    });
  }

  private announceForCreate(webSocket?: any) {
    const aggregateTransaction = this.createAggregateCompleteTransaction();
    if (this.needApostilleAccountSign()) {
      const signedTransaction = this.ownerAccount.signTransactionWithCosignatories(
        aggregateTransaction,
        [this.apostilleAccount.account as Account],
        this.networkGenerationHash,
      );
      return this.announceForComplete(signedTransaction, webSocket);
    }

    const signedTransaction = this.ownerAccount.sign(aggregateTransaction,
                                                     this.networkGenerationHash);
    return this.announceForComplete(signedTransaction, webSocket);
  }

  private async announceForUpdate(webSocket?: any) {
    const signType = await this.signTypeForUpdate();

    if (signType === SignType.NeedOtherCosignatory) {
      const transaction = this.createAggregateBondedTransaction();
      const signedTranasction = this.ownerAccount.sign(transaction, this.networkGenerationHash);
      return this.announceForBonded(signedTranasction, webSocket);
    }
    const transaction = this.createAggregateCompleteTransaction();
    if (signType === SignType.SingleCosignatoryOnly) {
      const signedTransaction = this.ownerAccount.sign(transaction, this.networkGenerationHash);
      return this.announceForComplete(signedTransaction, webSocket);
    }
    if (this.needApostilleAccountSign()) {
      const signedTransaction = this.ownerAccount.signTransactionWithCosignatories(
        transaction,
        [this.apostilleAccount.account as Account],
        this.networkGenerationHash,
      );
      return this.announceForComplete(signedTransaction, webSocket);
    }
    const signedTransaction = this.ownerAccount.sign(transaction, this.networkGenerationHash);
    return this.announceForComplete(signedTransaction, webSocket);
  }

  private needApostilleAccountSign() {
    if (this.apostilleAccount.account !== undefined
      && (this.legacyMetadataTransaction || this.assignOwnershipTransaction
      || this.announcePublicSinkTransaction || this.metadataTransactions)) {
      return true;
    }
    return false;
  }

  private async signTypeForUpdate() {
    const signType = await this.apostilleAccount.needSignType(this.url,
                                                              this.ownerAccount.publicKey);
    return signType;
  }

  private createAggregateCompleteTransaction() {
    let fee = 0;
    if (this.isFeeNetwork) {
      fee = 250000;
    }
    return AggregateTransaction.createComplete(
      Deadline.create(),
      this.innerTransactions(),
      this.networkType,
      [],
      UInt64.fromUint(fee),
    );
  }

  private createAggregateBondedTransaction() {
    let fee = 0;
    if (this.isFeeNetwork) {
      fee = 250000;
    }
    return AggregateTransaction.createBonded(
      Deadline.create(),
      this.innerTransactions(),
      this.networkType,
      [],
      UInt64.fromUint(fee),
    );
  }

  private innerTransactions() {
    const innerTransactions: InnerTransaction[] = [];
    innerTransactions.push(this.coreTransaction!);
    if (this.announcePublicSinkTransaction) {
      innerTransactions.push(this.announcePublicSinkTransaction!);
    }
    if (this.assignOwnershipTransaction) {
      innerTransactions.push(this.assignOwnershipTransaction!);
    }
    if (this.metadataTransactions) {
      Array.prototype.push.apply(innerTransactions, this.metadataTransactions);
    }
    if (this.legacyMetadataTransaction) {
      innerTransactions.push(this.legacyMetadataTransaction!);
    }
    return innerTransactions;
  }

  private signedFileHash() {
    return this.hashFunction.apostilleTransactionMessage(this.data,
                                                         this.ownerAccount.privateKey,
                                                         this.networkType);
  }

  private canAnnounce() {
    return (this.coreTransaction instanceof Transaction);
  }
}
