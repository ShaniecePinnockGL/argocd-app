package main

import (
	"bytes"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"time"
)

func runCommand(cmd string, args ...string) (string, string, error) {
	command := exec.Command(cmd, args...)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	outStr, errStr := string(stdout.Bytes()), string(stderr.Bytes())
	return outStr, errStr, err
}

func main() {
	context := flag.String("context", "", "K8s context used to run script (required)")
	namespace := flag.String("namespace", "", "K8s namespace to commands in (required)")
	application := flag.String("application", "", "Application to migrate (required)")
	region := flag.String("region", "", "Region (required)")
	tillerNamespace := flag.String("tiller-namespace", "", "Tiller namespace (required)")
	rancherToken := flag.String("rancher-token", "", "Rancher token (required)")
	rancherContext := flag.String("rancher-context", "", "Rancher context (required)")
	force := flag.Bool("force", false, "Ignores Argo CD Sync")
	flag.Parse()

	if *context == "" || *namespace == "" || *application == "" ||
		*region == "" || *tillerNamespace == "" || *rancherToken == "" || *rancherContext == "" {
		flag.PrintDefaults()
		os.Exit(1)
	}

	if *force {
		fmt.Print("Using -force can be dangerous, press enter to continue or ctrl + c to quit")
		var noop string
		_, _ = fmt.Scanln(&noop)
	}

	if *region != "e1" && *region != "e2" {
		fmt.Println("Invalid region. Must be one of (e1, e2)")
		os.Exit(1)
	}

	switchContext(context)
	validateNamespace(namespace)
	validateArgoCdAuth()
	validateArgoCdApp(*force, namespace, application, region)
	validateRancherAuth(rancherToken, rancherContext)
	validateRancherApp(application, namespace)
	validatePermissions(namespace)
	//validateHelm(stdOut, err, tillerNamespace, application, namespace)
	deleteConfigMaps(namespace, application)
	//validateHelmRemoval(stdOut, err, tillerNamespace, application, namespace)
	deleteRancherApp(application, namespace)
	validateArgoCdApp(false, namespace, application, region)
}

func validateArgoCdAppSynced(namespace *string, application *string, region *string) {
	stdOut, _, err := runCommand("argocd", "app", "list", "-l", fmt.Sprintf("environment=%s,application=%s", *namespace, *application))
	if !regexp.MustCompile(fmt.Sprintf(`%s-%s-%s[a-zA-Z0-9 ].*Synced .*Healthy`, *application, *namespace, *region)).MatchString(stdOut) {
		fmt.Printf("\u2718 %s application is not synced in %s environment\n", *application, *namespace)
		os.Exit(1)
	}
	if err != nil {
		fmt.Printf("\u2718 %s applications are not synced in argocd\n", *application)
		os.Exit(1)
	}
	fmt.Printf("\u2713 %s applications still synced in argocd\n", *application)
}

func deleteRancherApp(application *string, namespace *string) {
	_, _, err := runCommand("rancher", "app", "delete", fmt.Sprintf("%s-%s", *application, *namespace))
	if err != nil {
		fmt.Printf("\u2718 %s error deleting rancher app %s-%s \n", *application, *namespace)
		os.Exit(1)
	}
	fmt.Printf("\u2713 successfully deleted rancher app %s-%s\n", *application, *namespace)
	time.Sleep(5 * time.Second)
}

func validateHelmRemoval(tillerNamespace *string, application *string, namespace *string) {
	stdOut, _, err := runCommand("helm2", "list", "--tiller-namespace", *tillerNamespace, *application)
	if err != nil {
		fmt.Printf("\u2718 %s error getting helm applications in \n", *namespace)
		os.Exit(1)
	}
	if regexp.MustCompile(fmt.Sprintf(`%s-%s[a-zA-Z0-9 \t].*DEPLOYED`, *application, *namespace)).MatchString(stdOut) {
		fmt.Println(stdOut)
		fmt.Printf("\u2718 %s helm application still exists %s tiller namespace\n", *application, *tillerNamespace)
		os.Exit(1)
	}
	fmt.Printf("\u2713 validated %s helm application does not exist in %s tiller namespace \n", *application, *tillerNamespace)
}

func deleteConfigMaps(namespace *string, application *string) {
	_, _, err := runCommand("kubectl", "delete", "configmaps", "-n", *namespace, "-l", fmt.Sprintf("NAME=%s-%s", *application, *namespace))
	if err != nil {
		fmt.Printf("\u2718 failed to delete configmaps for %s in %s namespace: %s\n", *application, *namespace, err.Error())
		os.Exit(1)
	}
	fmt.Printf("\u2713 deleted configmaps for %s in %s namespace\n", *application, *namespace)
	time.Sleep(2 * time.Second)
}

func validateHelm(tillerNamespace *string, application *string, namespace *string) {
	stdOut, _, err := runCommand("helm2", "list", "--tiller-namespace", *tillerNamespace, *application)
	if err != nil {
		fmt.Printf("\u2718 error getting helm applications in %s\n", *namespace)
		os.Exit(1)
	}
	if !regexp.MustCompile(fmt.Sprintf(`%s-%s[a-zA-Z0-9 \t].*DEPLOYED`, *application, *namespace)).MatchString(stdOut) {
		fmt.Printf("\u2718 %s helm application not in %s namespace\n", *application, *namespace)
		os.Exit(1)
	}
	fmt.Printf("\u2713 validated %s helm application in %s tiller namespace \n", *application, *tillerNamespace)
}

func validatePermissions(namespace *string) {
	_, _, err := runCommand("kubectl", "auth", "can-i", "delete", "configmaps", "--namespace", *namespace)
	if err != nil {
		fmt.Printf("\u2718 not authorized to delete configmaps in %s namespace: %s\n", *namespace, err.Error())
		os.Exit(1)
	}
	fmt.Printf("\u2713 validated %s namespace permissions\n", *namespace)
}

func validateRancherApp(application *string, namespace *string) {
	stdOut, _, err := runCommand("rancher", "apps", "ls")
	if !regexp.MustCompile(fmt.Sprintf(`%s-%s[a-zA-Z0-9 ].*active`, *application, *namespace)).MatchString(stdOut) {
		fmt.Printf("\u2718 %s rancher application not in specified context\n", *application)
		os.Exit(1)
	}
	if err != nil {
		fmt.Printf("\u2718 unable to list rancher apps: %s\n", err.Error())
		os.Exit(1)
	}
	fmt.Printf("\u2713 validated %s rancher application in specified context\n", *application)
}

func validateRancherAuth(rancherToken *string, rancherContext *string) {
	_, _, err := runCommand("rancher", "login", "-t", *rancherToken, "--context", *rancherContext, "https://ops-rancher.greenlight.me/v3")
	if err != nil {
		fmt.Printf("\u2718 unable to authenticate with rancher: %s\n", err.Error())
		os.Exit(1)
	}
	fmt.Printf("\u2713 successfully authenticated with rancher\n")
}

func validateArgoCdApp(force bool, namespace *string, application *string, region *string) {
	if !force {
		stdOut, _, err := runCommand("argocd", "app", "list", "-l", fmt.Sprintf("environment=%s,application=%s", *namespace, *application))
		if !regexp.MustCompile(fmt.Sprintf(`%s-%s-%s[a-zA-Z0-9 ].*Synced .*Healthy`, *application, *namespace, *region)).MatchString(stdOut) {
			fmt.Printf("\u2718 %s application is not synced in %s environment\n", *application, *namespace)
			os.Exit(1)
		}
		if err != nil {
			fmt.Printf("\u2718 %s applications are not synced in argocd\n", *application)
			os.Exit(1)
		}
		fmt.Printf("\u2713 %s applications synced in argocd\n", *application)
	}
}

func validateArgoCdAuth() {
	_, _, err := runCommand("argocd", "app", "list")
	if err != nil {
		fmt.Printf("\u2718 failed to access argocd instance. please login using the command `argocd login argocd.external.glops.io --sso --grpc-web-root-path /`\n")
		os.Exit(1)
	}
	fmt.Printf("\u2713 argocd authenticated\n")
}

func validateNamespace(namespace *string) {
	_, _, err := runCommand("kubectl", "get", "namespace", *namespace)
	if err != nil {
		fmt.Printf("\u2718 failed to access %s namespace: %s\n", *namespace, err.Error())
		os.Exit(1)
	}
	fmt.Printf("\u2713 %s namespace exists\n", *namespace)
}

func switchContext(context *string) {
	_, _, err := runCommand("kubectl", "config", "use-context", *context)
	if err != nil {
		fmt.Printf("\u2718 failed to switch k8s context: %s\n", err.Error())
		os.Exit(1)
	}
	fmt.Printf("\u2713 successfully switched context to %s\n", *context)
}
