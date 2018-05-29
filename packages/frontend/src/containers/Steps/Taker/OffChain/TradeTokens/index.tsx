import * as React from 'react';
import { promisify } from '@0xproject/utils';
import Faucet from '../../../../../components/Faucet';
import { Token, OrderState, BlockParamLiteral, SignedOrder, ZeroEx } from '0x.js';
import { Dictionary } from 'lodash';
import { TokenAllowance } from '../../../../App';
import * as _ from 'lodash';
import { OffChainRelayerWebSocketChannel } from '../../../../../api/orderbook/offChain/webSocket';
import Segment from 'semantic-ui-react/dist/commonjs/elements/Segment/Segment';
import { Utils } from '../../../../../utils';
import { BigNumber } from 'bignumber.js';
import * as Web3 from 'web3';
import { UserActionMessageStatus } from '../../../../../components/UserActionMessage';
import { 
    TokenPair, 
    WebSocketMessage, 
    OrderbookSnapshot, 
    OrderbookUpdate, 
    OffChainEnrichedTokenPairOrderbook,
    PaymentNetworkUpdate,
    OffChainEnrichedSignedOrder,
    OffChainTokenPairOrderbook,
    OffChainSignedOrder,
    OffChainBatchFillOrder,
    OffChainBatchFillOrderRequest,
    OrderFilledQuantities,
    OffChainOrderbookSnapshot,
    OffChainOrderbookUpdate
} from '../../../../../types';
import { 
    DropdownProps, 
    Dropdown, 
    Button, 
    Container, 
    Form, 
    Radio, 
    TextArea, 
    Checkbox, 
    Input, 
    DropdownItemProps, 
    Grid, 
    Statistic, 
    Icon, 
    Divider, 
    Label,
    ButtonProps
} from 'semantic-ui-react';
import { OrderStateWatcher } from '0x.js/lib/src/order_watcher/order_state_watcher';
import { PaymentNetworkWebSocketClient } from '../../../../../api/paymentNetwork/webSocket';
import { PaymentNetworkRestfulClient } from '../../../../../api/paymentNetwork/rest';

export type TradeAction = 'Buy' | 'Sell';

interface Props {
    zeroEx: ZeroEx;
    tokensWithAllowance: Dictionary<TokenAllowance>;
    zeroExProxyTokens: Token[];
    accounts: string[];
    setTransactionMessageState: (status: UserActionMessageStatus, message?: string) => void;
}

interface State {
    tradeAction: TradeAction;
    tokenQuantity: BigNumber;
    baseToken: Token | undefined;
    quoteToken: Token | undefined;
    enrichedOrderbook: OffChainEnrichedTokenPairOrderbook | undefined;
    lowerBoundExchangeRate: BigNumber;
    upperBoundExchangeRate: BigNumber;
}

export default class OffChainTradeTokens extends React.Component<Props, State> {

    relayerWsChannel: OffChainRelayerWebSocketChannel | null;
    paymentNetworkWsClient: PaymentNetworkWebSocketClient | null;
    paymentNetworkRestClient: PaymentNetworkRestfulClient | null;

    // Sets maintain insertion order
    ordersToFill: Map<string, OffChainSignedOrder>;
    
    constructor(props: Props) {
        super(props);

        this.state = {
            tradeAction: 'Buy',
            tokenQuantity: new BigNumber(0),
            baseToken: undefined,
            quoteToken: undefined,
            enrichedOrderbook: undefined,
            lowerBoundExchangeRate: new BigNumber(0),
            upperBoundExchangeRate: new BigNumber(0),
        };
    }

    componentWillUnmount() {
        if (this.relayerWsChannel) {
            this.relayerWsChannel.closeConnection();
        }

        if (this.paymentNetworkWsClient) {
            this.paymentNetworkWsClient.closeConnection();
        }
    }

    fetchProxyTokenList = async () => {
        const tokens = await this.props.zeroEx.tokenRegistry.getTokensAsync();
    }

    handleTradeActionChange = async (e, { value }) => {
        await this.setState({ tradeAction: value });
        this.onPropertyChanged();
    }

    handleTokenQuantityChange = async (e, { value }) => {
        const previousState = Object.assign({}, this.state.tokenQuantity);
        if (value) {
            try {
                await this.setState( { tokenQuantity: new BigNumber(value) } );
                if (!previousState) {
                    this.onPropertyChanged();
                } else {
                    await this.calculateRateRange();
                }
            } catch( e ) {
                console.log(e);
            }
        }
    }

    handleBaseTokenDropDownItemSelected = async (e, data: DropdownProps) => {
        const itemProp = _.find(data.options, {value: data.value}) as DropdownItemProps;
        await this.setState({ baseToken: itemProp.token });
        this.onPropertyChanged();
    }

    handleQuoteTokenDropDownItemSelected = async (e, data: DropdownProps) => {
        const itemProp = _.find(data.options, {value: data.value}) as DropdownItemProps;
        await this.setState({ quoteToken: itemProp.token });
        this.onPropertyChanged();
    }

    onPropertyChanged = async () => {
        let baseToken = this.state.baseToken;
        let quoteToken = this.state.quoteToken;
        let tradeAction = this.state.tradeAction;
        
        if (baseToken && quoteToken && this.state.tokenQuantity.greaterThan(0)) {
            baseToken = baseToken as Token;
            quoteToken = quoteToken as Token;

            let tokenPair: TokenPair = tradeAction === 'Buy' ? 
            {
                base: baseToken,
                quote: quoteToken
            } : {
                base: quoteToken,
                quote: baseToken
            };

            if (this.relayerWsChannel) {
                await this.relayerWsChannel.initialiseConnection();
                await this.relayerWsChannel.subscribe(tokenPair);
            } 
        } else {
            this.ordersToFill = new Map();
        }
    }

    onRelayerSnapshot = async (snapshot: OffChainOrderbookSnapshot, tokenPair: TokenPair) => {
        const tokenPairOrderbook = Utils.OffChainTokenPairOrderbookFromJSON(snapshot);
        const takerAddress = this.props.accounts[0];

        // Log number of bids and asks currently in the orderbook
        const numberOfBids = tokenPairOrderbook.bids.length;
        const numberOfAsks = tokenPairOrderbook.asks.length;
        console.log(`SNAPSHOT: ${numberOfBids} bids & ${numberOfAsks} asks`);

        // Filter orders which takerAddress == order.maker
        tokenPairOrderbook.asks = tokenPairOrderbook.asks.filter((order: SignedOrder) => {
            return order.maker !== takerAddress;
        });

        tokenPairOrderbook.bids = tokenPairOrderbook.bids.filter((order: SignedOrder) => {
            return order.maker !== takerAddress;
        });

        // Enrich
        const enrichedOrderbook = await this.validateAndEnrichOrderbook(tokenPairOrderbook);

        // Sort bids and asks in order of best rates
        enrichedOrderbook.bids = enrichedOrderbook.bids.sort(this.sortEnrichedBids);
        enrichedOrderbook.asks = enrichedOrderbook.asks.sort(this.sortEnrichedAsks);

        this.setState({ enrichedOrderbook }, this.calculateRateRange);
    }

    sortEnrichedBids = (a: OffChainEnrichedSignedOrder, b: OffChainEnrichedSignedOrder) => {
        const orderRateA = a.remainingMakerTokenAmount.dividedBy(a.remainingTakerTokenAmount);
        const orderRateB = b.remainingMakerTokenAmount.dividedBy(b.remainingTakerTokenAmount);
        return orderRateB.comparedTo(orderRateA);
    }

    sortEnrichedAsks = (a: OffChainEnrichedSignedOrder, b: OffChainEnrichedSignedOrder) => {
        const orderRateA = a.remainingMakerTokenAmount.dividedBy(a.remainingTakerTokenAmount);
        const orderRateB = b.remainingMakerTokenAmount.dividedBy(b.remainingTakerTokenAmount);
        return orderRateA.comparedTo(orderRateB);
    }

    onRelayerUpdate = async (update: OffChainOrderbookUpdate, tokenPair: TokenPair) => {
        const enrichedOrderbook = Object.assign({}, this.state.enrichedOrderbook) as OffChainEnrichedTokenPairOrderbook;
        const order: OffChainSignedOrder = Utils.OffChainSignedOrderfromJSON(update);
        
        // Log order hash
        const orderHash = Utils.GetOffChainOrderHashHex(order);
        console.log(`NEW ORDER: ${orderHash}`);
        console.log('ask array length', JSON.stringify(this.state.enrichedOrderbook));

        // Return if order already exists in orderbook
        for (let x = 0; x < enrichedOrderbook.asks.length; x++) {
            if (Utils.GetOffChainOrderHashHex(enrichedOrderbook.asks[x].signedOrder) 
                    === Utils.GetOffChainOrderHashHex(order)
            ) {
                console.log('REPEAT ASK IGNORING');
                return;
            }
        }

        for (let x = 0; x < enrichedOrderbook.bids.length; x++) {
            if (Utils.GetOffChainOrderHashHex(enrichedOrderbook.bids[x].signedOrder) 
                    === Utils.GetOffChainOrderHashHex(order)
            ) {
                console.log('REPEAT BID IGNORING');
                return;
            }
        }

        // Enrich Order
        this.validateAndEnrichSignedOrder(order)
            .then((enrichedOrder: OffChainEnrichedSignedOrder) => {    
                // Ask - Taker buys base token, Maker buys quote token
                if (order.makerTokenAddress === tokenPair.base.address) {
                    // TODO: Find more efficient method of adding new asks in sorted fashion
                    enrichedOrderbook.asks.push(enrichedOrder);
                    enrichedOrderbook.asks.sort(this.sortEnrichedAsks);
                }

                // Bids - Maker buys base token, Taker buys quote token
                if (order.makerTokenAddress === tokenPair.quote.address) {
                    // TODO: Find more efficient method of adding new bids in sorted fashion
                    enrichedOrderbook.bids.push(enrichedOrder);
                    enrichedOrderbook.bids.sort(this.sortEnrichedBids);
                }
                
                this.setState({
                    enrichedOrderbook
                });

                return this.calculateRateRange();
            })
            .catch(err => {
                console.log(`Invalid Signed Order Update ${JSON.stringify(order)} with Error: ${err.message}`)
            }
        );
    }

    async validateAndEnrichOrderbook(
        orderbook: OffChainTokenPairOrderbook
    ): Promise<OffChainEnrichedTokenPairOrderbook> {

        let enrichedBids: OffChainEnrichedSignedOrder[] = [];
        let enrichedAsks: OffChainEnrichedSignedOrder[] = [];

        for (let x = 0; x < orderbook.asks.length; x++) {
            let order: OffChainSignedOrder = orderbook.asks[x];
            try {
                let enrichedOrder: OffChainEnrichedSignedOrder = await this.validateAndEnrichSignedOrder(order);
                enrichedAsks.push(enrichedOrder);
            } catch (e) {
                console.log(`Invalid Order Error ${e.message}`);
            }
        }

        for (let x = 0; x < orderbook.bids.length; x++) {
            let order: OffChainSignedOrder = orderbook.bids[x];
            try {
                let enrichedOrder: OffChainEnrichedSignedOrder = await this.validateAndEnrichSignedOrder(order);
                enrichedBids.push(enrichedOrder);
            } catch(e) {
                console.log(`Invalid Order Error ${e.message}`);
            }
        }

        const enrichedTokenPairOrderbook: OffChainEnrichedTokenPairOrderbook = {
            bids: enrichedBids,
            asks: enrichedAsks
        };

        console.log(`ENRICHED: ${enrichedBids.length} bids & ${enrichedAsks.length} asks`);

        return enrichedTokenPairOrderbook;
    }

    validateAndEnrichSignedOrder(signedOrder: OffChainSignedOrder): Promise<OffChainEnrichedSignedOrder> {
        const zeroEx = this.props.zeroEx;

        let orderHashHex: string = Utils.GetOffChainOrderHashHex(signedOrder);
        
        const enrichedOrder: OffChainEnrichedSignedOrder = {
            signedOrder: signedOrder,
            remainingMakerTokenAmount: signedOrder.makerTokenAmount,
            remainingTakerTokenAmount: signedOrder.takerTokenAmount
        };

        let remainingFillableTakerAmount = new BigNumber(0);

        return zeroEx
            .exchange
            .getCancelledTakerAmountAsync(orderHashHex)
            .then((cancelledTakerAmount: BigNumber) => {
                remainingFillableTakerAmount = remainingFillableTakerAmount.add(cancelledTakerAmount);
                return zeroEx.exchange.getFilledTakerAmountAsync(orderHashHex);
            })
            .then((filledTakerAmount: BigNumber) => {
                remainingFillableTakerAmount = remainingFillableTakerAmount.add(filledTakerAmount);
                
                if (!remainingFillableTakerAmount.lessThan(signedOrder.takerTokenAmount)) {
                    throw (
                        `Unfillable Order Error! Order has no fillable tokens remaining:\n
                        ${JSON.stringify(signedOrder)}`
                    );
                }

                const rate = enrichedOrder.signedOrder.makerTokenAmount.div(
                    enrichedOrder.signedOrder.takerTokenAmount
                );
                
                enrichedOrder.remainingTakerTokenAmount = enrichedOrder.remainingTakerTokenAmount.minus(
                    remainingFillableTakerAmount
                );

                enrichedOrder.remainingMakerTokenAmount = enrichedOrder.remainingMakerTokenAmount.minus(
                    remainingFillableTakerAmount.mul(rate)
                );

                return enrichedOrder;
            })
            .catch(err => {
                throw err;
            }
        );          
    }

    updateEnrichedOrderbook = async (
        orderHash: string, 
        remMakerTokenAmout: BigNumber,
        remTakerTokenAmount: BigNumber
    ): Promise<boolean> => {
        if (this.state.enrichedOrderbook) {
            const enrichedOrderbook = Object.assign({}, this.state.enrichedOrderbook);

            let enrichedOrder = enrichedOrderbook.asks.find(order => {
                return Utils.GetOffChainOrderHashHex(order.signedOrder) === orderHash;
            });
    
            enrichedOrder = enrichedOrder || enrichedOrderbook.bids.find(order => {
                return Utils.GetOffChainOrderHashHex(order.signedOrder) === orderHash;
            });

            // We don't want to return undefined hence the need for this check
            if (!enrichedOrder) {
                return false;
            }

            enrichedOrder.remainingMakerTokenAmount = remMakerTokenAmout;
            enrichedOrder.remainingTakerTokenAmount = remTakerTokenAmount;

            await this.setState({ enrichedOrderbook });

            return true;
        }
        return false;
    }

    removeOrderFromEnrichedOrderbook = async (
        orderHash: string, 
    ): Promise<void> => {
        if (this.state.enrichedOrderbook) {
            const enrichedOrderbook = Object.assign({}, this.state.enrichedOrderbook);

            enrichedOrderbook.asks.filter(order => {
                return Utils.GetOffChainOrderHashHex(order.signedOrder) !== orderHash;
            });
    
            enrichedOrderbook.bids.filter(order => {
                return Utils.GetOffChainOrderHashHex(order.signedOrder) !== orderHash;
            });

            await this.setState({ enrichedOrderbook });
        }
    }

    onPaymentNetworkOrderUpdate = (update: PaymentNetworkUpdate, tokenPair: TokenPair) => {
        const remMakerAmount = new BigNumber(update.remainingFillableMakerTokenAmount);
        const remTakerAmount = new BigNumber(update.remainingFillableTakerTokenAmount);
        const signedOrder = Utils.OffChainSignedOrderfromJSON(update.signedOrder);
        const orderHash: string = Utils.GetOffChainOrderHashHex(signedOrder);
        
        if (remMakerAmount.gt(0) && remTakerAmount.gt(0)) {
            this.updateEnrichedOrderbook(
                orderHash,
                remMakerAmount,
                remTakerAmount
            )
            .then((success: boolean) => {
                if (success) {
                    this.calculateRateRange();
                }
            });
        } else {
            this.removeOrderFromEnrichedOrderbook(orderHash);
        }
    }

    calculateRateRange = async () => {
        let baseToken = this.state.baseToken;
        let quoteToken = this.state.quoteToken;
        const tradeAction = this.state.tradeAction;
        const tokenQuantity = this.state.tokenQuantity;
        const enrichedOrderbook = this.state.enrichedOrderbook;

        let minExchangeRate;
        let maxExchangeRate;

        // (Ask, Buy) - Taker buys base token, Maker sells base token
        if (baseToken && 
            quoteToken && 
            tokenQuantity.greaterThan(0) &&
            tradeAction === 'Buy' && 
            enrichedOrderbook &&
            (enrichedOrderbook.asks.length > 0 || enrichedOrderbook.bids.length > 0)
        ) {
            const asks: OffChainEnrichedSignedOrder[] = enrichedOrderbook.asks;

            baseToken = this.state.baseToken as Token;
            quoteToken = this.state.quoteToken as Token;

            let lowerBoundBaseTokenQuantity: BigNumber = new BigNumber(0);
            let lowerBoundQuoteTokenQuantity: BigNumber = new BigNumber(0);

            let upperBoundBaseTokenQuantity: BigNumber = new BigNumber(0);
            let upperBoundQuoteTokenQuantity: BigNumber = new BigNumber(0);

            // TODO: Save to state
            this.ordersToFill = new Map();

            // Calculate Lower Bound
            let i;
            for (i = 0; i < asks.length; i++) {
                const enrichedOrder: OffChainEnrichedSignedOrder = asks[i];
                if (lowerBoundBaseTokenQuantity.lessThan(tokenQuantity)) {
                    console.log(`lower bound signed order: ${JSON.stringify(enrichedOrder)}`);

                    const makerTokenAmount = ZeroEx.toUnitAmount(
                        new BigNumber(enrichedOrder.remainingMakerTokenAmount),
                        baseToken.decimals
                    );
        
                    const takerTokenAmount = ZeroEx.toUnitAmount(
                        new BigNumber(enrichedOrder.remainingTakerTokenAmount),
                        quoteToken.decimals
                    );

                    let baseTokenQuantityToFill = tokenQuantity.minus(lowerBoundBaseTokenQuantity);
                    let orderRate = takerTokenAmount.div(makerTokenAmount);
                    
                    baseTokenQuantityToFill = BigNumber.min(baseTokenQuantityToFill, makerTokenAmount);

                    lowerBoundBaseTokenQuantity = lowerBoundBaseTokenQuantity.add(baseTokenQuantityToFill);

                    let quoteTokenQuantityToFill = orderRate.mul(baseTokenQuantityToFill);
                    lowerBoundQuoteTokenQuantity = lowerBoundQuoteTokenQuantity.add(quoteTokenQuantityToFill);

                    const hashHex = Utils.GetOffChainOrderHashHex(enrichedOrder.signedOrder);
                    if (!this.ordersToFill.has(Utils.GetOffChainOrderHashHex(enrichedOrder.signedOrder))) {
                        this.ordersToFill.set(hashHex, enrichedOrder.signedOrder);
                    }
                } else {
                    break;
                }
            }

            // Calculate conservative threadshold for upper bound estimate. Currently 2x
            i = (i * 2) >= asks.length ? asks.length - 1 : (i * 2) ;

            // Calculate Upper Bound
            for (i; i >= 0; i--) {
                const enrichedOrder: OffChainEnrichedSignedOrder = asks[i];
                if ((upperBoundBaseTokenQuantity.lessThan(tokenQuantity))) {
                    
                    const makerTokenAmount = ZeroEx.toUnitAmount(
                        new BigNumber(enrichedOrder.remainingMakerTokenAmount),
                        baseToken.decimals
                    );
        
                    const takerTokenAmount = ZeroEx.toUnitAmount(
                        new BigNumber(enrichedOrder.remainingTakerTokenAmount),
                        quoteToken.decimals
                    );

                    console.log(`upper bound signed order: ${JSON.stringify(enrichedOrder)}`);
                    let baseTokenQuantityToFill = tokenQuantity.minus(upperBoundBaseTokenQuantity);
                    let orderRate = takerTokenAmount.div(makerTokenAmount);

                    baseTokenQuantityToFill = BigNumber.min(baseTokenQuantityToFill, makerTokenAmount);

                    upperBoundBaseTokenQuantity = upperBoundBaseTokenQuantity.add(baseTokenQuantityToFill);

                    let quoteTokenQuantityToFill = orderRate.mul(baseTokenQuantityToFill);
                    upperBoundQuoteTokenQuantity = upperBoundQuoteTokenQuantity.add(quoteTokenQuantityToFill);

                    const hashHex = Utils.GetOffChainOrderHashHex(enrichedOrder.signedOrder);
                    if (!this.ordersToFill.has(Utils.GetOffChainOrderHashHex(enrichedOrder.signedOrder))) {
                        this.ordersToFill.set(hashHex, enrichedOrder.signedOrder);
                    }
                } else {
                    break;
                }
            }

            await this.setState({
                lowerBoundExchangeRate: lowerBoundQuoteTokenQuantity.div(lowerBoundBaseTokenQuantity),
                upperBoundExchangeRate: upperBoundQuoteTokenQuantity.div(upperBoundBaseTokenQuantity)
            });
        }
    }

    onClickTrade = async (event: React.MouseEvent<HTMLButtonElement>, data: ButtonProps) => {
        const takerAddress = this.props.accounts[0];
        const baseToken = this.state.baseToken as Token;
        const quoteToken = this.state.quoteToken as Token;
        const handleTxMsg = this.props.setTransactionMessageState;
        
        const fillQuantity = ZeroEx.toBaseUnitAmount(
            this.state.tokenQuantity,
            baseToken.decimals
        );

        if (this.ordersToFill.size > 0 
            && baseToken 
            && quoteToken 
            && fillQuantity.greaterThan(0)
        ) {
            handleTxMsg('LOADING');
            
            const orderArray: OffChainSignedOrder[] = Array.from(this.ordersToFill.values());
            
            console.log('off chain signed orders to fill:' + JSON.stringify(orderArray));
            console.log('Order fill amount:' + fillQuantity);
            console.log('Taker address:' + takerAddress);

            try {
                const paymentNetworkBatchFillOrder: OffChainBatchFillOrder = {
                    signedOrders: orderArray,
                    takerAddress: takerAddress,
                    takerFillAmount: fillQuantity
                };

                const orderHashHex = Utils.GetOffChainBatchFillOrderHashHex(paymentNetworkBatchFillOrder);

                const signature = await this.props.zeroEx.signOrderHashAsync(
                    orderHashHex,
                    takerAddress,
                    true
                );

                const paymentNetworkFillReq: OffChainBatchFillOrderRequest = {
                    ecSignature: signature,
                    ...paymentNetworkBatchFillOrder
                };

                if (this.paymentNetworkRestClient) {
                    const quantities: OrderFilledQuantities 
                        = await this.paymentNetworkRestClient.batchFillOrders(paymentNetworkFillReq);

                    const purchasedAmount = ZeroEx.toUnitAmount(
                        quantities.filledMakerAmount,
                        baseToken.decimals
                    );

                    const sellAmount = ZeroEx.toUnitAmount(
                        quantities.filledTakerAmount,
                        quoteToken.decimals
                    );

                    handleTxMsg(
                        'SUCCESS', 
                        `You have successfully purchased ${purchasedAmount} ${baseToken.symbol}` +  
                        ` in exchange for ${sellAmount} ${quoteToken.symbol}`
                    );
                }

            } catch (error) {
                handleTxMsg('FAILURE', error.message);
            }
        }
    }

    render() {
        const zeroExProxyTokens: Token[] = this.props.zeroExProxyTokens;
        const tokensWithAllowance: Dictionary<TokenAllowance> = this.props.tokensWithAllowance;
        const baseToken = this.state.baseToken;
        const quoteToken = this.state.quoteToken;
        const tradeAction = this.state.tradeAction;
        const lowerBoundExchangeRate = this.state.lowerBoundExchangeRate.toPrecision(4).toString();
        const upperBoundExchangeRate = this.state.upperBoundExchangeRate.toPrecision(4).toString();
        const lowerBoundTokenQuantity =  this.state.tokenQuantity.mul(lowerBoundExchangeRate).toPrecision(4).toString();
        const upperBoundTokenQuantity =  this.state.tokenQuantity.mul(upperBoundExchangeRate).toPrecision(4).toString();

        const baseTokenDropDownItems: DropdownItemProps[] = _.chain(zeroExProxyTokens)
            .filter((token: Token) => tokensWithAllowance[token.symbol])
            .map((token: Token) => {
                return {
                    key: token.symbol,
                    value: token.symbol, 
                    token: token, 
                    text: `${token.symbol}: ${token.name}`,
                };
            })
            .value();

        const quoteTokenDropDownItems: DropdownItemProps[] = _.map(zeroExProxyTokens, (token: Token) => {
            return {
                key: token.symbol,
                value: token.symbol,  
                token: token, 
                text: `${token.symbol}: ${token.name}`,
            };
        });

        let tokenStatistics;

        if (baseToken && quoteToken && this.state.tokenQuantity) {
            const b = baseToken as Token;
            const q = quoteToken as Token;
            tokenStatistics = (
                <Segment>
                    <Grid rows={3} textAlign="center" style={{margin: '1em 1em 1em 1em'}}>
                        <Grid.Row>
                            <Statistic size="small">
                                <Statistic.Value>{lowerBoundTokenQuantity} - {upperBoundTokenQuantity}</Statistic.Value>
                                <Statistic.Label>{q.symbol}</Statistic.Label>
                            </Statistic>
                        </Grid.Row>
                        <Grid.Row><h3>AT</h3></Grid.Row>
                        <Grid.Row>
                            <Statistic size="small">
                                <Statistic.Value>{lowerBoundExchangeRate} - {upperBoundExchangeRate}</Statistic.Value>
                                <Statistic.Label>{b.symbol}/{q.symbol}</Statistic.Label>
                            </Statistic>
                        </Grid.Row>
                    </Grid>
                </Segment>
            );
        } else {
            tokenStatistics = ( 
                <Segment textAlign="center">
                    <Statistic size="small">
                        <Statistic.Value>0</Statistic.Value>
                        <Statistic.Label>{quoteToken ? quoteToken.symbol : 'WETH'}</Statistic.Label>
                    </Statistic>
                </Segment>
            );
        }

        return (
            <Form style={{ height: '100%' }}>
                <OffChainRelayerWebSocketChannel
                    ref={ref => (this.relayerWsChannel = ref)} 
                    onSnapshot={this.onRelayerSnapshot}
                    onUpdate={this.onRelayerUpdate}
                />
                <PaymentNetworkWebSocketClient
                    ref={ref => (this.paymentNetworkWsClient = ref)} 
                    onUpdate={this.onPaymentNetworkOrderUpdate}
                />
                <PaymentNetworkRestfulClient
                    ref={ref => (this.paymentNetworkRestClient = ref)} 
                />
                <Form.Group inline style={{display: 'flex', justifyContent: 'center'}}>
                    <label>I would like to:</label>
                    <Form.Radio
                        control={Radio} 
                        label="Buy" 
                        value="Buy" 
                        checked={this.state.tradeAction === 'Buy'} 
                        onChange={this.handleTradeActionChange} 
                    />
                    <Form.Radio 
                        label="Sell" 
                        value="Sell" 
                        checked={this.state.tradeAction === 'Sell'} 
                        onChange={this.handleTradeActionChange} 
                    />
                </Form.Group>
                <Form.Input 
                    required
                    labelPosition="left"
                    label="Token Quantity" 
                    placeholder="Amount" 
                    onChange={this.handleTokenQuantityChange}
                />
                <Form.Dropdown 
                    required
                    selection 
                    label="Token" 
                    options={baseTokenDropDownItems}
                    onChange={this.handleBaseTokenDropDownItemSelected}
                    placeholder="Token"
                />
                <Form.Dropdown 
                    required
                    selection
                    label="In exchange for:" 
                    options={quoteTokenDropDownItems} 
                    onChange={this.handleQuoteTokenDropDownItemSelected}
                    placeholder="Token"
                />
                <Divider horizontal>You Will {tradeAction === 'Buy' ? 'Spend' : 'Purchase'}</Divider>
                {tokenStatistics}
                <div style={{margin: '1em', display: 'flex', justifyContent: 'center'}}>
                    <Form.Field 
                        required 
                        control={Checkbox} 
                        label="I agree to the Terms and Conditions"   
                    />
                </div>
                <div style={{margin: '1em', display: 'flex', justifyContent: 'center'}}>
                    <Form.Button onClick={this.onClickTrade}>
                        Trade
                    </Form.Button>
                </div>
            </Form>
        );
    }
}