'use strict'

// external deps 
var ObjectId = require("mongodb").ObjectId;
var BaseManager = require("module-toolkit").BaseManager;
var moment = require("moment");

// internal deps 
require("mongodb-toolkit");

var PurchaseRequestManager = require("../managers/purchasing/purchase-request-manager");
var PurchaseOrderManager = require('../managers/purchasing/purchase-order-manager');

module.exports = class FactPurchasingEtlManager extends BaseManager {
    constructor(db, user, sql) {
        super(db, user);
        this.sql = sql;
        this.purchaseRequestManager = new PurchaseRequestManager(db, user);
        this.purchaseOrderManager = new PurchaseOrderManager(db, user);
        this.migrationLog = this.db.collection("migration-log");
    }

    run() {
        var startedDate = new Date();
        this.migrationLog.insert({
            description: "Fact Pembelian from MongoDB to Azure DWH",
            start: startedDate,
        })
        return this.extract()
            .then((data) => this.transform(data))
            .then((data) => this.load(data))
            .then((results) => {
                var finishedDate = new Date();
                var spentTime = moment(finishedDate).diff(moment(startedDate), "minutes");
                var updateLog = {
                    description: "Fact Pembelian from MongoDB to Azure DWH",
                    start: startedDate,
                    finish: finishedDate,
                    executionTime: spentTime + " minutes",
                    status: "Successful"
                };
                this.migrationLog.updateOne({ start: startedDate }, updateLog);
            })
            .catch((err) => {
                var finishedDate = new Date();
                var spentTime = moment(finishedDate).diff(moment(startedDate), "minutes");
                var updateLog = {
                    description: "Fact Pembelian from MongoDB to Azure DWH",
                    start: startedDate,
                    finish: finishedDate,
                    executionTime: spentTime + " minutes",
                    status: err
                };
                this.migrationLog.updateOne({ start: startedDate }, updateLog);
            });
    }

    timestamp() {
        return this.migrationLog.find({
            description: "Fact Pembelian from MongoDB to Azure DWH",
            status: "Successful"
        }).sort({ finish: -1 }).limit(1).toArray()

    }

    extractPR(times) {
        var time = times.length > 0 ? times[0].start : "1970-01-01";
        var timestamp = new Date(time);
        return this.purchaseRequestManager.collection.find({
            _createdBy: {
                "$nin": ["dev", "unit-test"]
            },
            _updatedDate: {
                "$gt": timestamp
            }
        }).toArray()
    }

    extractPO(times) {
        var time = times.length > 0 ? times[0].start : "1970-01-01";
        var timestamp = new Date(time);
        return this.purchaseOrderManager.collection.find({
            _createdBy: {
                "$nin": ["dev", "unit-test"]
            },
            _updatedDate: {
                "$gt": timestamp
            }
        }).toArray()
    }

    getPRFromPO(datas) {
        var joinExtractedPR = datas.map((data) => {
            return data.purchaseRequest;
        })
        return Promise.all(joinExtractedPR)
    }

    extractPRFromPO() {
        return this.timestamp()
            .then((time) => this.extractPO(time))
            .then((datas) => this.getPRFromPO(datas))
    }

    extractPRfromPR() {
        return this.timestamp()
            .then((time) => this.extractPR(time))
    }

    joinPurchaseOrder(purchaseRequests) {
        var joinPurchaseOrders = purchaseRequests.map((purchaseRequest) => {
            return this.purchaseOrderManager.collection.find({
                _deleted: false,
                _createdBy: {
                    $nin: ["dev", "unit-test"]
                },
                purchaseRequestId: purchaseRequest._id
            }, {
                    _createdDate: 1,
                    _createdBy: 1,
                    no: 1,
                    _deleted: 1,
                    "purchaseOrderExternal._createdDate": 1,
                    "purchaseOrderExternal.no": 1,
                    "purchaseOrder.purchaseRequest.no": 1,
                    "purchaseOrderExternal.supplier.code": 1,
                    "purchaseOrderExternal.supplier.name": 1,
                    "purchaseOrderExternal.currency.code": 1,
                    "purchaseOrderExternal.currency.name": 1,
                    "purchaseOrderExternal.currency.description": 1,
                    "purchaseOrderExternal.paymentMethod": 1,
                    "purchaseOrderExternal.currencyRate": 1,
                    "purchaseOrderExternal.expectedDeliveryDate": 1,
                    "purchaseOrderExternal.date": 1,
                    "items.product.code": 1,
                    "items.product.name": 1,
                    "items.dealQuantity": 1,
                    "items.dealUom.unit": 1,
                    "items.pricePerDealUnit": 1,
                    "items.fulfillments.deliveryOrderNo": 1,
                    "items.fulfillments.deliveryOrderDate": 1,
                    "items.fulfillments.unitReceiptNoteNo": 1,
                    "items.fulfillments.unitReceiptNoteDate": 1,
                    "items.fulfillments.interNoteNo": 1,
                    "items.fulfillments.interNoteDate": 1
                }).toArray()
                .then((purchaseOrders) => {
                    var arr = purchaseOrders.map((purchaseOrder) => {
                        return {
                            purchaseRequest: purchaseRequest,
                            purchaseOrder: purchaseOrder
                        };
                    });

                    if (arr.length == 0)
                        arr.push({
                            purchaseRequest: purchaseRequest,
                            purchaseOrder: null
                        });
                    return Promise.resolve(arr);
                });
        });
        return Promise.all(joinPurchaseOrders)
            .then((joinPurchaseOrder => {
                return Promise.resolve([].concat.apply([], joinPurchaseOrder));
            }));
    }

    collectPR() {
        var purchaseRequest = this.extractPRfromPR();
        var prFromPOInternal = this.extractPRFromPO();
        return Promise.all([purchaseRequest, prFromPOInternal])
            .then((data) => {
                var purchaseRequest = data[0];
                var prFromPOInternal = data[1];
                return Promise.resolve(purchaseRequest.concat(prFromPOInternal))
            })
    }

    extract() {
        return this.collectPR()
            .then((data) => this.removeDuplicates(data))
            .then((purchaseRequest) => this.joinPurchaseOrder(purchaseRequest));
    }

    removeDuplicates(arr) {
        var new_arr = [];
        var lookup = {};

        for (var i in arr) {

            if (arr) {
                lookup[arr[i].no] = arr[i];
            }
        }

        for (i in lookup) {
            if (lookup) {
                new_arr.push(lookup[i]);
            }
        }

        return Promise.resolve(new_arr);
    }

    getRangeMonth(days) {
        if (days <= 30) {
            return "0-30 hari";
        } else if (days >= 31 && days <= 60) {
            return "31-60 hari";
        } else if (days >= 61 && days <= 90) {
            return "61-90 hari";
        } else if (days > 90) {
            return ">90 hari";
        }
    };

    getRangeWeek(days) {
        if (days <= 7) {
            return "0-7 hari";
        } else if (days >= 8 && days <= 14) {
            return "8-14 hari";
        } else if (days >= 15 && days <= 30) {
            return "15-30 hari";
        } else if (days > 30) {
            return ">30 hari";
        }
    };

    getCategoryType(catType) {
        if (catType === "BAHAN BAKU") {
            return "BAHAN BAKU";
        } else {
            return "NON BAHAN BAKU";
        }
    }

    getStatus(poDate, doDate) {
        var poDates = moment(poDate).startOf("day");
        var doDates = moment(doDate).startOf("day");
        var result = moment(doDates).diff(moment(poDates), "days")
        if (result <= 0) {
            return "Tepat Waktu";
        } else {
            return "Tidak Tepat Waktu";
        }
    }

    transform(data) {
        var result = data.map((item) => {
            var purchaseRequest = item.purchaseRequest;
            var purchaseOrder = item.purchaseOrder;

            if (item.purchaseOrder) {

                var results = purchaseOrder.items.map((poItem) => {
                    var catType = (purchaseRequest.category && purchaseRequest.category.name) ? purchaseRequest.category.name : null;

                    if (poItem.fulfillments.length > 0) {

                        return poItem.fulfillments.map((poFulfillment) => {
                            var prPoExtDays = (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal._createdDate) ? moment(moment(purchaseOrder.purchaseOrderExternal._createdDate).startOf("day")).diff(moment(moment(purchaseRequest._createdDate).startOf("day")), "days") : null;
                            var poIntDays = purchaseOrder._createdDate ? moment(moment(purchaseOrder._createdDate).startOf("day")).diff(moment(moment(purchaseRequest._createdDate).startOf("day")), "days") : null;
                            var poExtDays = (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal._createdDate) ? moment(moment(purchaseOrder.purchaseOrderExternal._createdDate).startOf("day")).diff(moment(moment(purchaseOrder._createdDate).startOf("day")), "days") : null;
                            var doDays = (poFulfillment.deliveryOrderDate && purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal._createdDate) ? moment(moment(poFulfillment.deliveryOrderDate).startOf("day")).diff(moment(moment(purchaseOrder.purchaseOrderExternal._createdDate).startOf("day")), "days") : null;
                            var urnDays = poFulfillment.unitReceiptNoteDate ? moment(moment(poFulfillment.unitReceiptNoteDate).startOf("day")).diff(moment(moment(poFulfillment.deliveryOrderDate).startOf("day")), "days") : null;
                            var upoDays = poFulfillment.interNoteDate ? moment(moment(poFulfillment.interNoteDate).startOf("day")).diff(moment(moment(poFulfillment.unitReceiptNoteDate).startOf("day")), "days") : null;
                            var poDays = poFulfillment.interNoteDate ? moment(moment(poFulfillment.interNoteDate).startOf("day")).diff(moment(moment(purchaseOrder._createdDate).startOf("day")), "days") : null;
                            var lastDeliveredDate = poFulfillment.deliveryOrderDate ? poItem.fulfillments[poItem.fulfillments.length - 1].deliveryOrderDate : null;
                            var catType = (purchaseRequest.category && purchaseRequest.category.name) ? purchaseRequest.category.name : null;

                            return {
                                purchaseRequestNo: purchaseRequest.no ? `'${purchaseRequest.no}'` : null,
                                purchaseRequestDate: purchaseRequest._createdDate ? `'${moment(purchaseRequest._createdDate).add(7, "hours").format('YYYY-MM-DD')}'` : null,
                                expectedPRDeliveryDate: purchaseRequest.expectedDeliveryDate ? `'${moment(purchaseRequest.expectedDeliveryDate).add(7, "hours").format('YYYY-MM-DD')}'` : null,
                                budgetCode: (purchaseRequest.budget && purchaseRequest.budget.code) ? `'${purchaseRequest.budget.code}'` : null,
                                budgetName: (purchaseRequest.budget && purchaseRequest.budget.name) ? `'${purchaseRequest.budget.name}'` : null,
                                unitCode: (purchaseRequest.unit && purchaseRequest.unit.code) ? `'${purchaseRequest.unit.code}'` : null,
                                unitName: (purchaseRequest.unit && purchaseRequest.unit.name) ? `'${purchaseRequest.unit.name}'` : null,
                                divisionCode: (purchaseRequest.unit && purchaseRequest.unit.division && purchaseRequest.unit.division.code) ? `'${purchaseRequest.unit.division.code}'` : null,
                                divisionName: (purchaseRequest.unit && purchaseRequest.unit.division && purchaseRequest.unit.division.name) ? `'${purchaseRequest.unit.division.name}'` : null,
                                categoryCode: (purchaseRequest.category && purchaseRequest.category.code) ? `'${purchaseRequest.category.code}'` : null,
                                categoryName: (purchaseRequest.category && purchaseRequest.category.name) ? `'${purchaseRequest.category.name}'` : null,
                                categoryType: (purchaseRequest.category && purchaseRequest.category.name) ? `'${this.getCategoryType(catType)}'` : null,
                                productCode: (poItem.product && poItem.product.code) ? `'${poItem.product.code}'` : null,
                                productName: (poItem.product && poItem.product.name) ? `'${poItem.product.name.replace(/'/g, '"')}'` : null,
                                purchaseRequestDays: purchaseOrder._createdDate ? `${poIntDays}` : null,
                                purchaseRequestDaysRange: purchaseOrder._createdDate ? `'${this.getRangeWeek(poIntDays)}'` : null,
                                prPurchaseOrderExternalDays: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal._createdDate) ? `${prPoExtDays}` : null,
                                prPurchaseOrderExternalDaysRange: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal._createdDate) ? `'${this.getRangeWeek(prPoExtDays)}'` : null,

                                purchaseOrderNo: purchaseOrder.no ? `'${purchaseOrder.no}'` : null,
                                purchaseOrderDate: purchaseOrder._createdDate ? `'${moment(purchaseOrder._createdDate).add(7, "hours").format('YYYY-MM-DD')}'` : null,
                                purchaseOrderExternalDays: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal._createdDate) ? `${poExtDays}` : null,
                                purchaseOrderExternalDaysRange: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal._createdDate) ? `'${this.getRangeWeek(poExtDays)}'` : null,
                                purchasingStaffName: purchaseOrder._createdBy ? `'${purchaseOrder._createdBy}'` : null,
                                prNoAtPo: purchaseRequest.no ? `'${purchaseRequest.no}'` : null,

                                purchaseOrderExternalNo: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal.no) ? `'${purchaseOrder.purchaseOrderExternal.no}'` : null,
                                purchaseOrderExternalDate: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal._createdDate) ? `'${moment(purchaseOrder.purchaseOrderExternal._createdDate).add(7, "hours").format('YYYY-MM-DD')}'` : null,
                                deliveryOrderDays: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal._createdDate && poFulfillment.deliveryOrderDate) ? `${doDays}` : null,
                                deliveryOrderDaysRange: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal._createdDate && poFulfillment.deliveryOrderDate) ? `'${this.getRangeMonth(doDays)}'` : null,
                                supplierCode: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal.supplier && purchaseOrder.purchaseOrderExternal.supplier.code) ? `'${purchaseOrder.purchaseOrderExternal.supplier.code}'` : null,
                                supplierName: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal.supplier && purchaseOrder.purchaseOrderExternal.supplier.name) ? `'${purchaseOrder.purchaseOrderExternal.supplier.name.replace(/'/g, '"')}'` : null,
                                currencyCode: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal.currency && purchaseOrder.purchaseOrderExternal.currency.code) ? `'${purchaseOrder.purchaseOrderExternal.currency.code}'` : null,
                                currencyName: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal.currency && purchaseOrder.purchaseOrderExternal.currency.description) ? `'${purchaseOrder.purchaseOrderExternal.currency.description}'` : null,
                                paymentMethod: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal.paymentMethod) ? `'${purchaseOrder.purchaseOrderExternal.paymentMethod}'` : null,
                                currencyRate: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal.currencyRate) ? `${purchaseOrder.purchaseOrderExternal.currencyRate}` : null,
                                purchaseQuantity: poItem.dealQuantity ? `${poItem.dealQuantity}` : null,
                                uom: (poItem.dealUom && poItem.dealUom.unit) ? `'${poItem.dealUom.unit}'` : null,
                                pricePerUnit: poItem.pricePerDealUnit ? `${poItem.pricePerDealUnit}` : null,
                                totalPrice: (purchaseOrder.purchaseOrderExternal && poItem.pricePerDealUnit && poItem.dealQuantity) ? `${poItem.dealQuantity * poItem.pricePerDealUnit * purchaseOrder.purchaseOrderExternal.currencyRate}` : null,
                                expectedDeliveryDate: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal.expectedDeliveryDate) ? `'${moment(purchaseOrder.purchaseOrderExternal.expectedDeliveryDate).add(7, "hours").format('YYYY-MM-DD')}'` : null,
                                prNoAtPoExt: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal.no) ? `'${purchaseRequest.no}'` : null,

                                deliveryOrderNo: poFulfillment.deliveryOrderNo ? `'${poFulfillment.deliveryOrderNo}'` : null,
                                deliveryOrderDate: poFulfillment.deliveryOrderDate ? `'${moment(poFulfillment.deliveryOrderDate).add(7, "hours").format('YYYY-MM-DD')}'` : null,
                                unitReceiptNoteDays: poFulfillment.unitReceiptNoteDate ? `${urnDays}` : null,
                                unitReceiptNoteDaysRange: poFulfillment.unitReceiptNoteDate ? `'${this.getRangeWeek(urnDays)}'` : null,
                                status: poFulfillment.deliveryOrderDate ? `'${this.getStatus(purchaseOrder.purchaseOrderExternal.expectedDeliveryDate, lastDeliveredDate)}'` : null,
                                prNoAtDo: poFulfillment.deliveryOrderNo ? `'${purchaseRequest.no}'` : null,

                                unitReceiptNoteNo: poFulfillment.unitReceiptNoteNo ? `'${poFulfillment.unitReceiptNoteNo}'` : null,
                                unitReceiptNoteDate: poFulfillment.unitReceiptNoteDate ? `'${moment(poFulfillment.unitReceiptNoteDate).add(7, "hours").format('YYYY-MM-DD')}'` : null,
                                unitPaymentOrderDays: poFulfillment.interNoteDate ? `${upoDays}` : null,
                                unitPaymentOrderDaysRange: poFulfillment.interNoteDate ? `'${this.getRangeWeek(upoDays)}'` : null,

                                unitPaymentOrderNo: poFulfillment.interNoteNo ? `'${poFulfillment.interNoteNo}'` : null,
                                unitPaymentOrderDate: poFulfillment.interNoteDate ? `'${moment(poFulfillment.interNoteDate).add(7, "hours").format('YYYY-MM-DD')}'` : null,
                                purchaseOrderDays: poFulfillment.interNoteDate ? `${poDays}` : null,
                                purchaseOrderDaysRange: poFulfillment.interNoteDate ? `'${this.getRangeMonth(poDays)}'` : null,
                                invoicePrice: poFulfillment.interNoteDate ? `'${poItem.pricePerDealUnit}'` : null,
                                deletedPR: `'${purchaseRequest._deleted}'`,
                                deletedPO: `'${purchaseOrder._deleted}'`
                            };
                        });
                    } else if (poItem.fulfillments.length === 0) {
                        var prPoExtDays = (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal._createdDate) ? moment(moment(purchaseOrder.purchaseOrderExternal._createdDate).startOf("day")).diff(moment(moment(purchaseRequest._createdDate).startOf("day")), "days") : null;
                        var poExtDays = (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal._createdDate) ? moment(moment(purchaseOrder.purchaseOrderExternal._createdDate).startOf("day")).diff(moment(moment(purchaseOrder._createdDate).startOf("day")), "days") : null;
                        var poIntDays = purchaseOrder._createdDate ? moment(moment(purchaseOrder._createdDate).startOf("day")).diff(moment(moment(purchaseRequest._createdDate).startOf("day")), "days") : null;
                        return {
                            purchaseRequestNo: purchaseRequest.no ? `'${purchaseRequest.no}'` : null,
                            purchaseRequestDate: purchaseRequest._createdDate ? `'${moment(purchaseRequest._createdDate).add(7, "hours").format('YYYY-MM-DD')}'` : null,
                            expectedPRDeliveryDate: purchaseRequest.expectedDeliveryDate ? `'${moment(purchaseRequest.expectedDeliveryDate).add(7, "hours").format('YYYY-MM-DD')}'` : null,
                            budgetCode: (purchaseRequest.budget && purchaseRequest.budget.code) ? `'${purchaseRequest.budget.code}'` : null,
                            budgetName: (purchaseOrder.purchaseRequest && purchaseOrder.purchaseRequest.budget && purchaseOrder.purchaseRequest.budget.name) ? `'${purchaseOrder.purchaseRequest.budget.name}'` : null,
                            unitCode: (purchaseRequest.unit && purchaseRequest.unit.code) ? `'${purchaseRequest.unit.code}'` : null,
                            unitName: (purchaseRequest.unit && purchaseRequest.unit.name) ? `'${purchaseRequest.unit.name}'` : null,
                            divisionCode: (purchaseRequest.unit && purchaseRequest.unit.division && purchaseRequest.unit.division.code) ? `'${purchaseRequest.unit.division.code}'` : null,
                            divisionName: (purchaseRequest.unit && purchaseRequest.unit.division && purchaseRequest.unit.division.name) ? `'${purchaseRequest.unit.division.name}'` : null,
                            categoryCode: (purchaseRequest.category && purchaseRequest.category.code) ? `'${purchaseRequest.category.code}'` : null,
                            categoryName: (purchaseRequest.category && purchaseRequest.category.name) ? `'${purchaseRequest.category.name}'` : null,
                            categoryType: (purchaseRequest.category && purchaseRequest.category.name) ? `'${this.getCategoryType(catType)}'` : null,
                            productCode: (poItem.product && poItem.product.code) ? `'${poItem.product.code}'` : null,
                            productName: (poItem.product && poItem.product.name) ? `'${poItem.product.name.replace(/'/g, '"')}'` : null,
                            purchaseRequestDays: purchaseRequest ? `${poIntDays}` : null,
                            purchaseRequestDaysRange: purchaseRequest ? `'${this.getRangeWeek(poIntDays)}'` : null,
                            prPurchaseOrderExternalDays: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal._createdDate) ? `${prPoExtDays}` : null,
                            prPurchaseOrderExternalDaysRange: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal._createdDate) ? `'${this.getRangeWeek(prPoExtDays)}'` : null,

                            purchaseOrderNo: purchaseOrder.no ? `'${purchaseOrder.no}'` : null,
                            purchaseOrderDate: purchaseOrder._createdDate ? `'${moment(purchaseOrder._createdDate).add(7, "hours").format('YYYY-MM-DD')}'` : null,
                            purchaseOrderExternalDays: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal._createdDate) ? `${poExtDays}` : null,
                            purchaseOrderExternalDaysRange: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal._createdDate) ? `'${this.getRangeWeek(poExtDays)}'` : null,
                            purchasingStaffName: purchaseOrder._createdBy ? `'${purchaseOrder._createdBy}'` : null,
                            prNoAtPo: purchaseOrder.no ? `'${purchaseRequest.no}'` : null,

                            purchaseOrderExternalNo: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal.no) ? `'${purchaseOrder.purchaseOrderExternal.no}'` : null,
                            purchaseOrderExternalDate: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal._createdDate) ? `'${moment(purchaseOrder.purchaseOrderExternal._createdDate).add(7, "hours").format('YYYY-MM-DD')}'` : null,
                            deliveryOrderDays: null,
                            deliveryOrderDaysRange: null,
                            supplierCode: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal.supplier && purchaseOrder.purchaseOrderExternal.supplier.code) ? `'${purchaseOrder.purchaseOrderExternal.supplier.code}'` : null,
                            supplierName: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal.supplier && purchaseOrder.purchaseOrderExternal.supplier.name) ? `'${purchaseOrder.purchaseOrderExternal.supplier.name.replace(/'/g, '"')}'` : null,
                            currencyCode: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal.currency && purchaseOrder.purchaseOrderExternal.currency.code) ? `'${purchaseOrder.purchaseOrderExternal.currency.code}'` : null,
                            currencyName: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal.currency && purchaseOrder.purchaseOrderExternal.currency.description) ? `'${purchaseOrder.purchaseOrderExternal.currency.description}'` : null,
                            paymentMethod: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal.paymentMethod) ? `'${purchaseOrder.purchaseOrderExternal.paymentMethod}'` : null,
                            currencyRate: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal.currencyRate) ? `${purchaseOrder.purchaseOrderExternal.currencyRate}` : null,
                            purchaseQuantity: poItem.defaultQuantity ? `${poItem.defaultQuantity}` : null,
                            uom: (poItem.defaultUom && poItem.defaultUom.unit) ? `'${poItem.defaultUom.unit}'` : null,
                            pricePerUnit: (purchaseOrder.purchaseOrderExternal.no && purchaseOrder.purchaseOrderExternal) ? `${poItem.pricePerDealUnit}` : null,
                            totalPrice: (purchaseOrder.purchaseOrderExternal.currencyRate && poItem.pricePerDealUnit && poItem.dealQuantity) ? `${poItem.dealQuantity * poItem.pricePerDealUnit * purchaseOrder.purchaseOrderExternal.currencyRate}` : null,
                            expectedDeliveryDate: (purchaseOrder.purchaseOrderExternal && purchaseOrder.purchaseOrderExternal.expectedDeliveryDate) ? `'${moment(purchaseOrder.purchaseOrderExternal.expectedDeliveryDate).add(7, "hours").format('YYYY-MM-DD')}'` : null,
                            prNoAtPoExt: purchaseOrder.purchaseOrderExternal.no ? `'${purchaseRequest.no}'` : null,

                            deliveryOrderNo: null,
                            deliveryOrderDate: null,
                            unitReceiptNoteDays: null,
                            unitReceiptNoteDaysRange: null,
                            status: null,
                            prNoAtDo: null,

                            unitReceiptNoteNo: null,
                            unitReceiptNoteDate: null,
                            unitPaymentOrderDays: null,
                            unitPaymentOrderDaysRange: null,

                            unitPaymentOrderNo: null,
                            unitPaymentOrderDate: null,
                            purchaseOrderDays: null,
                            purchaseOrderDaysRange: null,
                            invoicePrice: null,
                            deletedPR: `'${purchaseRequest._deleted}'`,
                            deletedPO: `'${purchaseOrder._deleted}'`
                        }
                    }
                });
                return [].concat.apply([], results);
            }
            else if (item.purchaseRequest) {
                var results = purchaseRequest.items.map((poItem) => {
                    var catType = (purchaseRequest.category && purchaseRequest.category.name) ? `'${purchaseRequest.category.name}'` : null;

                    return {
                        purchaseRequestNo: purchaseRequest.no ? `'${purchaseRequest.no}'` : null,
                        purchaseRequestDate: purchaseRequest._createdDate ? `'${moment(purchaseRequest._createdDate).add(7, "hours").format('YYYY-MM-DD')}'` : null,
                        expectedPRDeliveryDate: purchaseRequest.expectedDeliveryDate ? `'${moment(purchaseRequest.expectedDeliveryDate).add(7, "hours").format('YYYY-MM-DD')}'` : null,
                        budgetCode: (purchaseRequest.budget && purchaseRequest.budget.code) ? `'${purchaseRequest.budget.code}'` : null,
                        budgetName: (purchaseRequest.budget && purchaseRequest.budget.name) ? `'${purchaseRequest.budget.name}'` : null,
                        unitCode: (purchaseRequest.unit && purchaseRequest.unit.code) ? `'${purchaseRequest.unit.code}'` : null,
                        unitName: (purchaseRequest.unit && purchaseRequest.unit.name) ? `'${purchaseRequest.unit.name}'` : null,
                        divisionCode: (purchaseRequest.unit && purchaseRequest.unit.division && purchaseRequest.unit.division.code) ? `'${purchaseRequest.unit.division.code}'` : null,
                        divisionName: (purchaseRequest.unit && purchaseRequest.unit.division && purchaseRequest.unit.division.name) ? `'${purchaseRequest.unit.division.name}'` : null,
                        categoryCode: (purchaseRequest.category && purchaseRequest.category.code) ? `'${purchaseRequest.category.code}'` : null,
                        categoryName: purchaseRequest.category && purchaseRequest.category.name ? `'${purchaseRequest.category.name}'` : null,
                        categoryType: (purchaseRequest.category && purchaseRequest.category.name) ? `'${this.getCategoryType(catType)}'` : null,
                        productCode: (poItem.product && poItem.product.code) ? `'${poItem.product.code}'` : null,
                        productName: (poItem.product && poItem.product.name) ? `'${poItem.product.name.replace(/'/g, '"')}'` : null,
                        purchaseRequestDays: null,
                        purchaseRequestDaysRange: null,
                        prPurchaseOrderExternalDays: null,
                        prPurchaseOrderExternalDaysRange: null,

                        purchaseOrderNo: null,
                        purchaseOrderDate: null,
                        purchaseOrderExternalDays: null,
                        purchaseOrderExternalDaysRange: null,
                        purchasingStaffName: null,
                        prNoAtPo: null,

                        purchaseOrderExternalNo: null,
                        purchaseOrderExternalDate: null,
                        deliveryOrderDays: null,
                        deliveryOrderDaysRange: null,
                        supplierCode: null,
                        supplierName: null,
                        currencyCode: null,
                        currencyName: null,
                        paymentMethod: null,
                        currencyRate: null,
                        purchaseQuantity: poItem.quantity ? `${poItem.quantity}` : null,
                        uom: (poItem.product && poItem.product.uom && poItem.product.uom.unit) ? `'${poItem.product.uom.unit}'` : null,
                        pricePerUnit: null,
                        totalPrice: null,
                        expectedDeliveryDate: null,
                        prNoAtPoExt: null,

                        deliveryOrderNo: null,
                        deliveryOrderDate: null,
                        unitReceiptNoteDays: null,
                        unitReceiptNoteDaysRange: null,
                        status: null,
                        prNoAtDo: null,

                        unitReceiptNoteNo: null,
                        unitReceiptNoteDate: null,
                        unitPaymentOrderDays: null,
                        unitPaymentOrderDaysRange: null,

                        unitPaymentOrderNo: null,
                        unitPaymentOrderDate: null,
                        purchaseOrderDays: null,
                        purchaseOrderDaysRange: null,
                        invoicePrice: null,
                        deletedPR: `'${purchaseRequest._deleted}'`,
                        deletedPO: null
                    };
                });
                return [].concat.apply([], results);
            }
        });
        return Promise.resolve([].concat.apply([], result));
    }

    insertQuery(sql, query) {
        return new Promise((resolve, reject) => {
            sql.query(query, function (err, result) {
                if (err) {
                    reject(err);
                } else {
                    resolve(result);
                }
            })
        })
    }

    load(data) {
        return new Promise((resolve, reject) => {
            this.sql.startConnection()
                .then(() => {

                    var transaction = this.sql.transaction();

                    transaction.begin((err) => {

                        var request = this.sql.transactionRequest(transaction);
                        var command = [];
                        var sqlQuery = 'INSERT INTO [ag_fact_pembelian_temp]';
                        var count = 1;

                        for (var item of data) {
                            if (item) {
                                var queryString = `\nSELECT ${item.purchaseRequestNo}, ${item.purchaseRequestDate === null ? null : item.purchaseRequestDate.replace("/0017", "/2017").replace("/12017", "/2017").replace("/0200", "/2017").replace("/0201", "/2017")}, ${item.expectedPRDeliveryDate === null ? null : item.expectedPRDeliveryDate.replace("/0017", "/2017").replace("/12017", "/2017").replace("/0200", "/2017").replace("/0201", "/2017")}, ${item.budgetCode}, ${item.budgetName}, ${item.unitCode}, ${item.unitName}, ${item.divisionCode}, ${item.divisionName}, ${item.categoryCode}, ${item.categoryName}, ${item.categoryType}, ${item.productCode}, ${item.productName}, ${item.purchaseRequestDays}, ${item.purchaseRequestDaysRange}, ${item.prPurchaseOrderExternalDays}, ${item.prPurchaseOrderExternalDaysRange}, ${item.purchaseOrderNo}, ${item.purchaseOrderDate === null ? null : item.purchaseOrderDate.replace("/0017", "/2017").replace("/12017", "/2017").replace("/0200", "/2017").replace("/0201", "/2017")}, ${item.purchaseOrderExternalDays}, ${item.purchaseOrderExternalDaysRange}, ${item.purchasingStaffName}, ${item.prNoAtPo}, ${item.purchaseOrderExternalNo}, ${item.purchaseOrderExternalDate === null ? null : item.purchaseOrderExternalDate.replace("/0017", "/2017").replace("/12017", "/2017").replace("/0200", "/2017").replace("/0201", "/2017")}, ${item.deliveryOrderDays}, ${item.deliveryOrderDaysRange}, ${item.supplierCode}, ${item.supplierName}, ${item.currencyCode}, ${item.currencyName}, ${item.paymentMethod}, ${item.currencyRate}, ${item.purchaseQuantity}, ${item.uom}, ${item.pricePerUnit}, ${item.totalPrice}, ${item.expectedDeliveryDate === null ? null : item.expectedDeliveryDate.replace("/0017", "/2017").replace("/12017", "/2017").replace("/0200", "/2017").replace("/0201", "/2017")}, ${item.prNoAtPoExt}, ${item.deliveryOrderNo}, ${item.deliveryOrderDate === null ? null : item.deliveryOrderDate.replace("/0017", "/2017").replace("/12017", "/2017").replace("/0200", "/2017").replace("/0201", "/2017")}, ${item.unitReceiptNoteDays}, ${item.unitReceiptNoteDaysRange}, ${item.status}, ${item.prNoAtDo}, ${item.unitReceiptNoteNo}, ${item.unitReceiptNoteDate === null ? null : item.unitReceiptNoteDate.replace("/0017", "/2017").replace("/12017", "/2017").replace("/0200", "/2017").replace("/0201", "/2017")}, ${item.unitPaymentOrderDays}, ${item.unitPaymentOrderDaysRange}, ${item.unitPaymentOrderNo}, ${item.unitPaymentOrderDate === null ? null : item.unitPaymentOrderDate.replace("/0017", "/2017").replace("/12017", "/2017").replace("/0200", "/2017").replace("/0201", "/2017")}, ${item.purchaseOrderDays}, ${item.purchaseOrderDaysRange}, ${item.invoicePrice}, ${item.deletedPR}, ${item.deletedPO} UNION ALL `;
                                sqlQuery = sqlQuery.concat(queryString);
                                if (count % 10000 == 0) {
                                    sqlQuery = sqlQuery.substring(0, sqlQuery.length - 10);
                                    command.push(this.insertQuery(request, sqlQuery));
                                    sqlQuery = 'INSERT INTO [ag_fact_pembelian_temp]';
                                }
                                console.log(`add data to query  : ${count}`);
                                count++;
                            }
                        }

                        if (sqlQuery != "") {
                            sqlQuery = sqlQuery.substring(0, sqlQuery.length - 10);
                            command.push(this.insertQuery(request, `${sqlQuery}`));
                        }

                        this.sql.multiple = true;

                        var fs = require("fs");
                        var path = "C:\\Users\\indri.hutabalian\\Desktop\\fact-pembelian.txt";

                        fs.writeFile(path, sqlQuery, function (error) {
                            if (error) {
                                console.log("write error:  " + error.message);
                            } else {
                                console.log("Successful Write to " + path);
                            }
                        });

                        return Promise.all(command)
                            .then((results) => {
                                request.execute("AG_UPSERT_FACT_PEMBELIAN").then((execResult) => {
                                    request.execute("AG_INSERT_DIMTIME").then((execResult) => {
                                        transaction.commit((err) => {
                                            if (err)
                                                reject(err);
                                            else
                                                resolve(results);
                                        });
                                    }).catch((error) => {
                                        transaction.rollback((err) => {
                                            console.log("rollback")
                                            if (err)
                                                reject(err)
                                            else
                                                reject(error);
                                        });
                                    })
                                }).catch((error) => {
                                    transaction.rollback((err) => {
                                        console.log("rollback")
                                        if (err)
                                            reject(err)
                                        else
                                            reject(error);
                                    });
                                })
                            })
                            .catch((error) => {
                                transaction.rollback((err) => {
                                    console.log("rollback");
                                    if (err)
                                        reject(err)
                                    else
                                        reject(error);
                                });
                            });
                    })
                })
                .catch((err) => {
                    reject(err);
                })
        })
    }
}