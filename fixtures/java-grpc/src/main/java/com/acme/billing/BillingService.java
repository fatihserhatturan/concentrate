package com.acme.billing;

import com.acme.billing.v1.BillingGrpc;
import io.grpc.stub.StreamObserver;

// The generated BillingGrpc is not in the scan: the shape of the methods decides what an rpc is.
public class BillingService extends BillingGrpc.BillingImplBase {
    @Override
    public void charge(ChargeRequest request, StreamObserver<ChargeReply> responseObserver) {
        responseObserver.onCompleted();
    }

    public StreamObserver<ChargeRequest> batch(StreamObserver<ChargeReply> responseObserver) {
        return null;
    }

    public void refund(String id) {}

    private void audit(ChargeRequest request, StreamObserver<ChargeReply> responseObserver) {}

    public static void create(ChargeRequest request, StreamObserver<ChargeReply> responseObserver) {}
}
