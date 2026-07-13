package main

import (
	"fmt"
	"io"
	"net"
	"os"
	"sync"
)

const (
	listenAddress = ":8080"
	routerSocket  = "/run/ploinky/router.sock"
)

func proxy(client *net.TCPConn) {
	defer client.Close()

	router, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: routerSocket, Net: "unix"})
	if err != nil {
		fmt.Fprintln(os.Stderr, "[ploinky-network-gateway] router socket unavailable")
		return
	}
	defer router.Close()

	var streams sync.WaitGroup
	streams.Add(2)
	go func() {
		defer streams.Done()
		_, _ = io.Copy(router, client)
		_ = router.CloseWrite()
	}()
	go func() {
		defer streams.Done()
		_, _ = io.Copy(client, router)
		_ = client.CloseWrite()
	}()
	streams.Wait()
}

func main() {
	if len(os.Args) != 1 {
		fmt.Fprintln(os.Stderr, "[ploinky-network-gateway] arguments are not supported")
		os.Exit(2)
	}

	listener, err := net.Listen("tcp4", listenAddress)
	if err != nil {
		fmt.Fprintln(os.Stderr, "[ploinky-network-gateway] cannot listen on TCP 8080")
		os.Exit(1)
	}
	defer listener.Close()

	for {
		connection, err := listener.Accept()
		if err != nil {
			fmt.Fprintln(os.Stderr, "[ploinky-network-gateway] TCP accept failed")
			continue
		}
		go proxy(connection.(*net.TCPConn))
	}
}
